import type { ISdk } from 'iii-sdk'
import { emitKvWrite } from './kv-write-hooks.js'
import { kvListCaller, recordKvList } from './kv-list-stats.js'

// A lone surrogate cannot be encoded as UTF-8. The state worker never answers
// a set carrying one, and the caller waits out its invocation timeout (live
// 2026-09-11: 180 s, retried hundreds of times for two rows). Every string in
// a value is checked before it leaves the process; a clean value passes
// through as the same object.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

function stripLoneSurrogates(value: unknown): unknown {
  if (typeof value === 'string') {
    return LONE_SURROGATE.test(value) ? value.replace(LONE_SURROGATE, '') : value
  }
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const next = stripLoneSurrogates(item)
      if (next !== item) changed = true
      return next
    })
    return changed ? out : value
  }
  if (value && typeof value === 'object') {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const next = stripLoneSurrogates(item)
      if (next !== item) changed = true
      out[key] = next
    }
    return changed ? out : value
  }
  return value
}

export class StateKV {
  constructor(private sdk: ISdk) {}

  async get<T = unknown>(scope: string, key: string): Promise<T | null> {
    return this.sdk.trigger<{ scope: string; key: string }, T | null>({
      function_id: 'state::get',
      payload: { scope, key },
    })
  }

  async set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    const clean = stripLoneSurrogates(value) as T
    const result = await this.sdk.trigger<{ scope: string; key: string; value: T }, T>({
      function_id: 'state::set',
      payload: { scope, key, value: clean },
    })
    emitKvWrite(this, { op: 'set', scope, key, value: clean })
    return result
  }

  async update<T = unknown>(
    scope: string,
    key: string,
    ops: Array<{ type: string; path: string; value?: unknown }>,
  ): Promise<T> {
    const cleanOps = stripLoneSurrogates(ops) as typeof ops
    const result = await this.sdk.trigger<
      { scope: string; key: string; ops: Array<{ type: string; path: string; value?: unknown }> },
      T
    >({
      function_id: 'state::update',
      payload: { scope, key, ops: cleanOps },
    })
    emitKvWrite(this, { op: 'update', scope, key, value: result })
    return result
  }

  async delete(scope: string, key: string): Promise<void> {
    await this.sdk.trigger<{ scope: string; key: string }, void>({
      function_id: 'state::delete',
      payload: { scope, key },
    })
    emitKvWrite(this, { op: 'delete', scope, key })
  }

  async list<T = unknown>(scope: string): Promise<T[]> {
    const caller = kvListCaller()
    const rows = await this.sdk.trigger<{ scope: string }, T[]>({
      function_id: 'state::list',
      payload: { scope },
    })
    recordKvList(scope, rows as unknown[], caller)
    return rows
  }

  /**
   * The scope's keys, without any value.
   *
   * `state::list` has no pagination and answers a scope as one message: the
   * biggest live scope came back as 59.2 MB in 1.5 s on 2026-09-20, while
   * `state::list_keys` answered the same 6,890 rows in 158 KB and 72 ms. The
   * state worker is a closed package, so this is the pagination it has.
   */
  async listKeys(scope: string): Promise<string[]> {
    const answer = await this.sdk.trigger<{ scope: string }, { keys?: string[] } | string[]>({
      function_id: 'state::list_keys',
      payload: { scope },
    })
    if (Array.isArray(answer)) return answer
    return answer?.keys ?? []
  }

  /**
   * One window of a scope: its keys, then a get per row in the window.
   *
   * For a caller that wants a bounded read. A full scan this way costs one
   * round trip per row, which is slower than the single message `list`
   * sends, so this does not replace it. A key whose row is gone by the time
   * it is read is left out; `total` still counts it, because it is the key
   * count the window was taken from.
   */
  async listPage<T = unknown>(
    scope: string,
    { offset = 0, limit = 100 }: { offset?: number; limit?: number } = {},
  ): Promise<{ rows: T[]; total: number; hasMore: boolean }> {
    const keys = await this.listKeys(scope)
    const window = keys.slice(offset, offset + limit)
    const rows: T[] = []
    for (const key of window) {
      const row = await this.get<T>(scope, key)
      if (row !== null && row !== undefined) rows.push(row)
    }
    return { rows, total: keys.length, hasMore: offset + window.length < keys.length }
  }
}
