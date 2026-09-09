# iii Engine Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move AgentMemory's runtime from iii engine 0.11.2 on Windows to iii 0.23.x on Linux, so the engine stops accumulating memory and the project stops running four and a half months behind upstream.

**Architecture:** The engine, the `state` worker and the `http` worker run on Linux. AgentMemory's Node worker stays on Windows and registers with the Linux engine over TCP — this is already proven, the spike probe did exactly that. The store stays where it is on `D:` and is mounted into Linux; full-store read throughput over that mount measured 123 MB/s, which a targeted-read KV store can live with, and Task 4 measures the real workload before the cutover commits to it.

**Tech Stack:** iii engine 0.23.x (Rust), `iii-sdk` 0.23.x (npm), AgentMemory worker (TypeScript → `dist/`), Docker Desktop 29.6.2 or WSL2 Ubuntu, Windows 11.

**Spec:** `records/core-recovery/verification/iii-upgrade-spike-20260909.md` and the `spike-result` evidence entries dated 2026-09-09/10 in `.worktrees/reliability-spine/.swe-cycle/state.json`. Those record the three answers this plan is built on.

## Global Constraints

- **The spike already answered the three unknowns. Do not re-litigate them.** The store opens with no migration (fingerprint byte-identical: 867 files / 969,832,460 bytes / nameset `a8aed4d2e8068957`). The config translates. The HTTP trigger contract survives — `POST /spike/ping` returned `HTTP 200` in 0.0087 s through the exact `registerTrigger({type:"http", config:{api_path, http_method}})` shape AgentMemory uses 140 times.
- **AgentMemory needs exactly two iii workers: `state` and `http`.** `grep` over `src/` finds zero references to queue, pubsub or cron. Declaring `queue` also breaks on the official image (its binary wants a newer GLIBC than `iiidev/iii:latest` provides).
- **`iii-worker-manager` must be declared under `engine.workers` with `host: 0.0.0.0`**, or no external SDK worker can register. This cost one debugging cycle already.
- Windows is not a target for the worker packages. `http` publishes no Windows binary at all. Do not attempt a Windows-native 0.23.x runtime.
- **Never point a 0.23.x engine at `data-base/instance-25` until Task 5.** Rehearse on `spike-instance-99`.
- The live runtime (engine 0.11.2 + worker on 5611/5612/51634) stays up until Task 5 and must be restorable at every point before it.
- Secrets: `AGENTMEMORY_SECRET` is in `%USERPROFILE%\.agentmemory\.env`. Never print its value.
- Every task appends one append-only `evidence` entry to `.worktrees/reliability-spine/.swe-cycle/state.json`.
- Baseline to hold: `npx tsc --noEmit` reports **34** errors and the suite is **2,120 passed / 21 skipped** with only the auth-requiring `test/integration.test.ts` failing. A task that changes either number has broken something.

---

### Task 1: Choose the Linux host, and pin the engine version

**Files:**
- Create: `records/core-recovery/verification/iii-migration-host-decision.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `$HOST` = `docker` or `wsl`, and `$ENGINE_VERSION` = the version that host can actually run. Every later task branches on these two.

- [ ] **Step 1: Measure the standing cost of each option**

```bash
powershell.exe -NoProfile -Command "Get-Process | Where-Object { \$_.Name -match 'vmmem|Docker|com.docker' } | Measure-Object -Property WorkingSet64 -Sum | ForEach-Object { 'docker stack: {0} MB' -f [int](\$_.Sum/1MB) }"
```
Recorded on 2026-09-09: `vmmemWSL` 2,080 MB plus ~754 MB of Windows-side Docker processes, ≈2.8 GB total.

- [ ] **Step 2: Establish what version each host can run**

Docker Hub's newest `iiidev/iii` tag is `0.23.0` — verified by listing tags; there is no 0.23.1-rc image. The GitHub release carries `iii-x86_64-unknown-linux-gnu.tar.gz` for `0.23.1-rc.3`, which a WSL2 Ubuntu can run directly.

```bash
curl -s -m 60 "https://hub.docker.com/v2/repositories/iiidev/iii/tags?page_size=25" | python -c "import sys,json;print([r['name'] for r in json.load(sys.stdin)['results']][:8])"
```

- [ ] **Step 3: Decide, and write down why**

Take `wsl` unless installing a distro is blocked: it drops ~754 MB of Docker Desktop processes and reaches 0.23.1-rc.3, which carries the trace-archive eviction fix (iii-hq/iii#2068) that 0.23.0 lacks. Take `docker` if a distro cannot be installed — it is already working and proven, at the cost of pinning to 0.23.0.

Write the decision, both costs, and the version each host reaches into the decision record.

- [ ] **Step 4: Append evidence**

```bash
python -c "
import json,io,datetime
p='D:/AGENTMEMORY_FOR_ME/.worktrees/reliability-spine/.swe-cycle/state.json'
d=json.load(io.open(p,encoding='utf-8'))
d['evidence'].append({'stage':'S5','at':datetime.datetime.now().isoformat(timespec='seconds'),'kind':'host-decision','detail':'REPLACE: host chosen (docker|wsl), engine version it reaches, measured standing cost, and the reason.'})
io.open(p,'w',encoding='utf-8').write(json.dumps(d,ensure_ascii=False,indent=2)+chr(10))
print('evidence',len(d['evidence']))
"
```

---

### Task 2: Rewire AgentMemory's SDK types behind one shim

**Files:**
- Create: `src/iii-compat.ts`
- Modify: `package.json:69` (the `iii-sdk` pin)
- Modify: every file importing from `"iii-sdk"` — 70 files for `ISdk`, 2 for `ApiRequest`
- Test: `test/iii-compat.test.ts`

**Interfaces:**
- Consumes: `$ENGINE_VERSION` from Task 1 (the SDK pin must match the engine's minor).
- Produces: `src/iii-compat.ts` exporting `ISdk`, `ApiRequest`, `ApiResponse`, `HttpRequest`, `HttpResponse`, `TriggerAction`, `registerWorker` under their current names, so no call site changes shape.

The 0.23.x root export drops `ISdk`, `ApiRequest`, `ApiResponse`, `HttpResponse` and `Logger`; `HttpRequest` survives only under `iii-sdk/internal`; `ISdk` is renamed `IIIClient` with `registerTrigger`, `registerFunction`, `trigger` and `shutdown` keeping identical signatures. In 0.11.2 `ApiRequest<TBody> = HttpRequest<TBody>`, so the HTTP shapes can be defined locally instead of importing an internal path.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import type { ISdk, ApiRequest, ApiResponse } from "../src/iii-compat.js";
import { TriggerAction, registerWorker } from "../src/iii-compat.js";

describe("iii-compat", () => {
  it("re-exports the names the codebase uses", () => {
    expect(typeof registerWorker).toBe("function");
    expect(TriggerAction).toBeDefined();
  });

  it("keeps ApiRequest assignable from a plain HTTP request shape", () => {
    const req: ApiRequest<{ q: string }> = {
      body: { q: "hello" },
    } as ApiRequest<{ q: string }>;
    expect(req.body?.q).toBe("hello");
  });

  it("keeps ApiResponse assignable from a status/body pair", () => {
    const res: ApiResponse = { status_code: 200, body: { ok: true } };
    expect(res.status_code).toBe(200);
  });

  it("types a client with the four methods the codebase calls", () => {
    const shape: Array<keyof ISdk> = [
      "registerFunction",
      "registerTrigger",
      "trigger",
      "shutdown",
    ];
    expect(shape).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/iii-compat.test.ts`
Expected: FAIL — `Cannot find module '../src/iii-compat.js'`.

- [ ] **Step 3: Write the shim**

```typescript
// One place where the codebase's names meet whatever the installed iii-sdk
// calls them. 0.23.x renamed ISdk to IIIClient and dropped ApiRequest,
// ApiResponse, HttpRequest, HttpResponse and Logger from the public API;
// HttpRequest survives only under iii-sdk/internal, which is explicitly
// internal and not worth depending on. In 0.11.2 ApiRequest was only an alias
// of HttpRequest, and both are plain data shapes, so they are defined here
// instead of imported. 143 ApiRequest call sites and 147 ISdk sites keep
// working unchanged.
import type { IIIClient } from "iii-sdk";

export { TriggerAction, registerWorker } from "iii-sdk";

export type ISdk = IIIClient;

export interface HttpRequest<TBody = unknown> {
  body?: TBody;
  headers?: Record<string, string>;
  query_params?: Record<string, string>;
  path_params?: Record<string, string>;
  method?: string;
  path?: string;
}

export type ApiRequest<TBody = unknown> = HttpRequest<TBody>;

export interface HttpResponse<TBody = unknown> {
  status_code: number;
  headers?: Record<string, string>;
  body?: TBody;
}

export type ApiResponse<TBody = unknown> = HttpResponse<TBody>;
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run test/iii-compat.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Point every import at the shim**

```bash
cd "D:/AGENTMEMORY_FOR_ME/.worktrees/synthetic-core-integration" && python -c "
import io, re, subprocess
files = subprocess.run(['git','grep','-l','from \"iii-sdk\"','--','src'], capture_output=True, text=True).stdout.split()
changed = 0
for f in files:
    if f.endswith('src/iii-compat.ts'): continue
    raw = io.open(f, 'rb').read()
    new = raw.replace(b'from \"iii-sdk\"', b'from \"./iii-compat.js\"' if f.count('/') == 1 else b'from \"../iii-compat.js\"')
    if new != raw:
        io.open(f, 'wb').write(new); changed += 1
print('rewrote', changed, 'files')
"
```
The relative depth differs per directory, so re-run `npx tsc --noEmit` and fix any unresolved path by hand — the compiler names each one.

- [ ] **Step 6: Bump the pin and install**

```bash
cd "D:/AGENTMEMORY_FOR_ME/.worktrees/synthetic-core-integration" && python -c "
import io
p='package.json'; s=io.open(p,encoding='utf-8',newline='').read()
s=s.replace('\"iii-sdk\": \"0.11.2\"','\"iii-sdk\": \"REPLACE_WITH_ENGINE_VERSION\"')
io.open(p,'w',encoding='utf-8',newline='').write(s); print('pinned')
" && npm install --silent
```
Substitute the version Task 1 chose — `0.23.0` for the docker host, `0.23.1-rc.3` for wsl.

- [ ] **Step 7: Hold the baseline**

Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"` — expected `34`, the pre-existing count. Anything higher is a real regression introduced here; fix it before continuing.
Run: `npx vitest run` — expected `2124 passed | 21 skipped` (2,120 plus the four new ones), only `test/integration.test.ts` failing.

- [ ] **Step 8: Commit**

```bash
cd "D:/AGENTMEMORY_FOR_ME/.worktrees/synthetic-core-integration" && git add -A && git grep --cached -n -E 'sk-[A-Za-z0-9]{20,}|AGENTMEMORY_SECRET\s*=\s*[A-Za-z0-9]|ghp_[A-Za-z0-9]{20,}' -- $(git diff --cached --name-only) ; git commit -m "iii: route every SDK import through one compatibility shim"
```
The credential scan must print nothing before the commit runs.

---

### Task 3: Build the live compose file and the Linux runtime harness

**Files:**
- Create: `validation-runtime/capability-cohort-20260901/data-base/instance-25/worker-compose.yaml`
- Create: `records/core-recovery/tools/native-runtime-0.23-launch.ps1`
- Read only: `validation-runtime/capability-cohort-20260901/data-base/spike-instance-99/worker-compose.yaml` (the proven spike file)

**Interfaces:**
- Consumes: `$HOST`, `$ENGINE_VERSION`.
- Produces: a compose file that serves the live ports (5611 http, 51634 worker-manager) against the live store, and a launcher that brings the Linux side up and reports when it is listening.

- [ ] **Step 1: Write the live compose file**

Identical in shape to the spike file that worked, with live ports and the live store path. Ports 5611 and 51634 must be free — that means the old engine is stopped, which is Task 5, so this file is written now and first used in Task 4 against the spike copy.

```yaml
namespace: default
startup_timeout: 360s

engine:
  url: ws://127.0.0.1:51634
  workers:
    iii-worker-manager:
      host: 0.0.0.0
      port: 51634

containers:
  state:
    worker: package://state
    version: "0.22.5-rc.1"
    working_dir: .
    config_override:
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: /data/state_store.db
  http:
    worker: package://http
    version: "0.21.6"
    start_after: [state]
    config_override:
      host: 0.0.0.0
      port: 5611
      default_timeout: 180000
```

- [ ] **Step 2: Write the launcher**

For the docker host it runs one `docker run -d` with `-p 5611:5611 -p 51634:51634`, the store mounted at `/data`, and the compose file mounted at `/work`; for wsl it runs `iii compose --up -f` inside the distro. Both then poll until the ports listen, and both print what they started so the supervisor can log it.

- [ ] **Step 3: Verify the launcher against the spike copy, not the live store**

Point it at `spike-instance-99` and the spike ports, run it, confirm both ports listen, then stop it. The launcher must not be first exercised during the cutover.

- [ ] **Step 4: Append evidence and commit**

Record that the launcher started and stopped cleanly against the copy, with the ports it bound.

---

### Task 4: Rehearse the whole cutover against the copy

**Files:**
- Modify: `records/core-recovery/verification/iii-migration-host-decision.md` (add a `## Rehearsal` section)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: measured search latency and engine memory for the real AgentMemory worker against a 0.23.x engine — the numbers that justify or stop the cutover.

- [ ] **Step 1: Start the Linux engine against `spike-instance-99` on the spike ports**

- [ ] **Step 2: Start the real AgentMemory worker against it**

Run `dist/cli.mjs` with `--instance 99` and the spike data dir, so it registers with the Linux engine exactly as the probe did.

- [ ] **Step 3: Confirm the REST surface actually answers**

```bash
S=$(grep -m1 '^\s*AGENTMEMORY_SECRET\s*=' "$USERPROFILE/.agentmemory/.env" | sed 's/^[^=]*=//' | sed 's/[[:space:]]\+#.*$//' | tr -d '"'"'"'\r'); curl -s -m 120 -H "Authorization: Bearer $S" http://127.0.0.1:5711/agentmemory/graph/stats -w '\n[HTTP %{http_code} in %{time_total}s]\n' | tail -3
```
Expected: `HTTP 200` and a node/edge count matching the live store's. A 404 means the trigger registrations did not survive the shim; a timeout means the mounted store is too slow and the store must move onto the Linux filesystem.

- [ ] **Step 4: Measure search latency against today's numbers**

```bash
S=$(grep -m1 '^\s*AGENTMEMORY_SECRET\s*=' "$USERPROFILE/.agentmemory/.env" | sed 's/^[^=]*=//' | sed 's/[[:space:]]\+#.*$//' | tr -d '"'"'"'\r'); for i in 1 2 3; do curl -s -m 120 -H "Authorization: Bearer $S" -H 'Content-Type: application/json' -X POST http://127.0.0.1:5711/agentmemory/search -d '{"query":"connector outbox backlog drain","limit":10}' -o /dev/null -w 'search %{time_total}s\n'; done
```
Today's live figures are 1,243 ms mean warm and 3.5 s cold. Materially worse here means the mount is the problem, and the store moves to Linux before Task 5.

- [ ] **Step 5: Measure engine memory under that load**

```bash
docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' 2>&1 | head -5
```
Idle it measured 86 MiB. Record what it is with a real worker attached and searches running.

- [ ] **Step 6: Write the rehearsal section and append evidence**

---

### Task 5: Cut the live runtime over, with the rollback rehearsed first

**Files:**
- Modify: `records/core-recovery/tools/native-runtime-candidate-supervisor.ps1`
- Modify: `records/core-recovery/tools/native-runtime-candidate-launch.mjs`
- Create: `records/core-recovery/verification/iii-migration-cutover-20260910.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the live runtime on 0.23.x, or a documented rollback.

- [ ] **Step 1: Write down the rollback before doing anything**

The rollback is: stop the Linux engine, start `C:\Users\nasca\.agentmemory\bin\iii.exe` with the original `iii-config.native.yaml`, restart the worker from the current `dist/`. It works because the spike proved 0.23.x does not migrate the store — the fingerprint was byte-identical after a full run. Verify that claim once more against the live store's fingerprint immediately before and after the first 0.23.x start.

- [ ] **Step 2: Back up the live store**

```bash
nohup cp -r "D:/AGENTMEMORY_FOR_ME/validation-runtime/capability-cohort-20260901/data-base/instance-25" "D:/AGENTMEMORY_FOR_ME/validation-runtime/capability-cohort-20260901/data-base/_백업_원본_instance-25_20260910-pre-0.23" > /dev/null 2>&1 &
```
Wait for `du -sh` on both to match before continuing. This is the one irreversible-looking step made reversible.

- [ ] **Step 3: Stop the old runtime**

Stop the worker, then `iii.exe`. Record both pids.

- [ ] **Step 4: Fingerprint the live store, start the Linux engine, fingerprint again**

Identical fingerprints confirm the rollback stays available. Different ones mean stop and restore from the Step 2 backup.

- [ ] **Step 5: Start the worker and verify the surface**

Health, `graph/stats`, and one search, all against 5611 as before. The node and edge counts must match what the old runtime reported.

- [ ] **Step 6: Update the supervisor and launcher to drive the new path**

Both currently assume `iii.exe --config`. They must start the Linux side instead, and the freeze verifier must hash the compose file and the engine image digest rather than `iii.exe`.

- [ ] **Step 7: Watch memory for an hour and record it**

The whole point. Sample every five minutes and compare against the 3,711 MB the old engine was holding.

- [ ] **Step 8: Write the cutover record, append evidence, commit**

---

## Self-Review

**Spec coverage.** The spec's three answers become constraints rather than tasks, which is why no task re-tests them. The spec's open question — Docker versus WSL — is Task 1. The SDK surface the spec enumerated (ISdk→IIIClient, ApiRequest/HttpResponse/Logger dropped, HttpRequest internal-only, sdk.on and getMeter absent but already runtime-guarded) is covered by Task 2's shim; the two guarded call sites need no change, which is why no task touches them.

**Placeholder scan.** Two deliberate `REPLACE` markers remain: Task 1 Step 4's evidence detail and Task 2 Step 6's version string. Both name exactly what to substitute and both depend on a decision made inside the plan. Task 3 Step 2 describes the launcher's behaviour rather than showing its code, because the code differs entirely between the two hosts and the host is not chosen until Task 1 — the branch is stated, not hidden.

**Type consistency.** `$HOST`, `$ENGINE_VERSION`, `src/iii-compat.ts`, `ISdk`/`ApiRequest`/`ApiResponse`/`HttpRequest`/`HttpResponse`, the ports 5611/51634 live and 5711/5712/51734 spike, and the store fingerprint `867 files / 969,832,460 bytes / a8aed4d2e8068957` are spelled identically everywhere they appear.
