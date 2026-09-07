import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultConnectorOutboxes,
  inspectConnectorOutboxes,
  recoverConnectorOutboxClaims,
  registerConnectorOutboxReplayFunctions,
  replayConnectorOutboxes,
  resolveOutboxScanLimit,
  startConnectorOutboxReplayLoop,
} from "../src/functions/connector-outbox.js";
import { mockSdk } from "./helpers/mocks.js";

async function writeEnvelope(
  dir: string,
  name: string,
  value: Record<string, unknown>,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), JSON.stringify(value), "utf8");
}

describe("connector outbox replay", () => {
  it("uses only the explicit outbox during an isolated runtime", () => {
    const explicit = join(tmpdir(), "agentmemory-isolated-outbox");
    expect(
      defaultConnectorOutboxes(
        { AGENTMEMORY_OUTBOX_DIR: explicit },
        join(tmpdir(), "unrelated-home"),
      ),
    ).toEqual([{ adapter: "configured", dir: explicit }]);
  });

  it("replays only current envelopes fairly while preserving legacy backlog", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-replay-"));
    const codex = join(root, "codex");
    const hermes = join(root, "hermes");
    const calls: Array<{ url: string; body: Record<string, unknown>; authorization?: string }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body || "{}")),
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      });
      return new Response(
        new URL(String(url)).pathname.endsWith("/observe")
          ? JSON.stringify({ deduplicated: true })
          : "{}",
        { status: 201 },
      );
    });

    try {
      await writeEnvelope(codex, "legacy.json", {
        path: "/agentmemory/observe",
        body: { captureId: "codex:legacy" },
        createdAt: "2026-08-30T00:00:00.000Z",
      });
      await writeEnvelope(codex, "current-1.json", {
        schemaVersion: 2,
        path: "/agentmemory/observe",
        body: { captureId: "codex:current-1" },
        createdAt: "2026-08-30T00:00:01.000Z",
      });
      await writeEnvelope(codex, "current-2.json", {
        schemaVersion: 2,
        path: "/agentmemory/observe",
        body: { captureId: "codex:current-2" },
        createdAt: "2026-08-30T00:00:02.000Z",
      });
      await writeEnvelope(hermes, "current.json", {
        schemaVersion: 2,
        path: "session/start",
        body: { sessionId: "hermes-current", includeContext: false },
        createdAt: "2026-08-30T00:00:03.000Z",
      });

      const result = await replayConnectorOutboxes({
        outboxes: [
          { adapter: "codex", dir: codex },
          { adapter: "hermes", dir: hermes },
        ],
        baseUrl: "http://127.0.0.1:3111",
        secret: "local-secret",
        fetchImpl: fetchMock,
        timeoutMs: 50,
        limit: 2,
      });

      expect(result).toMatchObject({
        delivered: 2,
        deduplicated: 1,
        newlyAccepted: 1,
        failed: 0,
        legacySkipped: 1,
      });
      expect(calls.map(({ body }) => body)).toEqual([
        { captureId: "codex:current-1" },
        { sessionId: "hermes-current", includeContext: false },
      ]);
      expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
        "/agentmemory/observe",
        "/agentmemory/session/start",
      ]);
      expect(calls.every(({ authorization }) => authorization === "Bearer local-secret")).toBe(true);
      expect(await readdir(codex)).toEqual(["current-2.json", "legacy.json"]);
      expect(await readdir(hermes)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a failed claim pending without blocking another adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-failure-"));
    const codex = join(root, "codex");
    const hermes = join(root, "hermes");
    const fetchMock = vi.fn(async (url: string | URL) =>
      new URL(String(url)).pathname.endsWith("/observe")
        ? new Response("unavailable", { status: 503 })
        : new Response("{}", { status: 200 }),
    );

    try {
      await writeEnvelope(codex, "codex.json", {
        schemaVersion: 2,
        path: "/agentmemory/observe",
        body: { captureId: "codex:failed" },
      });
      await writeEnvelope(hermes, "hermes.json", {
        schemaVersion: 2,
        path: "session/end",
        body: { sessionId: "hermes-ok" },
      });

      const result = await replayConnectorOutboxes({
        outboxes: [
          { adapter: "codex", dir: codex },
          { adapter: "hermes", dir: hermes },
        ],
        baseUrl: "http://127.0.0.1:3111",
        fetchImpl: fetchMock,
        timeoutMs: 50,
        limit: 2,
      });

      expect(result).toMatchObject({ delivered: 1, failed: 1 });
      expect(await readdir(codex)).toEqual(["codex.json"]);
      expect(await readdir(hermes)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("finishes a terminal-priority session group before older normal backlog", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-terminal-"));
    const codex = join(root, "codex");
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      const path = new URL(String(url)).pathname;
      calls.push({ path, body });
      if (body.captureId === "codex:old-poison") {
        return new Response("unavailable", { status: 503 });
      }
      return new Response(
        path.endsWith("/observe")
          ? JSON.stringify({ observationId: body.captureId })
          : "{}",
        { status: path.endsWith("/observe") ? 201 : 200 },
      );
    });

    try {
      await writeEnvelope(codex, "0-old.json", {
        schemaVersion: 2,
        path: "/agentmemory/observe",
        body: { captureId: "codex:old-poison", sessionId: "old-session" },
        createdAt: "2026-08-30T00:00:00.000Z",
      });
      await writeEnvelope(codex, "1-current-observe.json", {
        schemaVersion: 2,
        path: "/agentmemory/observe",
        body: { captureId: "codex:current", sessionId: "current-session" },
        createdAt: "2026-08-30T00:00:02.000Z",
      });
      await writeEnvelope(codex, "2-current-end.json", {
        schemaVersion: 2,
        priority: "terminal",
        path: "/agentmemory/session/end",
        body: { sessionId: "current-session" },
        createdAt: "2026-08-30T00:00:03.000Z",
      });

      const result = await replayConnectorOutboxes({
        outboxes: [{ adapter: "codex", dir: codex }],
        baseUrl: "http://127.0.0.1:3111",
        fetchImpl: fetchMock,
        timeoutMs: 50,
        limit: 20,
      });

      expect(result).toMatchObject({
        delivered: 2,
        newlyAccepted: 2,
        failed: 0,
      });
      expect(calls).toEqual([
        {
          path: "/agentmemory/observe",
          body: { captureId: "codex:current", sessionId: "current-session" },
        },
        {
          path: "/agentmemory/session/end",
          body: { sessionId: "current-session" },
        },
      ]);
      expect(await readdir(codex)).toEqual(["0-old.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not deliver terminal end after an observation in its group fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-terminal-failure-"));
    const codex = join(root, "codex");
    const paths: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return new Response("unavailable", { status: 503 });
    });

    try {
      await writeEnvelope(codex, "observe.json", {
        schemaVersion: 2,
        path: "/agentmemory/observe",
        body: { captureId: "codex:failed", sessionId: "current-session" },
        createdAt: "2026-08-30T00:00:00.000Z",
      });
      await writeEnvelope(codex, "end.json", {
        schemaVersion: 2,
        priority: "terminal",
        path: "/agentmemory/session/end",
        body: { sessionId: "current-session" },
        createdAt: "2026-08-30T00:00:01.000Z",
      });

      const result = await replayConnectorOutboxes({
        outboxes: [{ adapter: "codex", dir: codex }],
        baseUrl: "http://127.0.0.1:3111",
        fetchImpl: fetchMock,
        timeoutMs: 50,
        limit: 20,
      });

      expect(result).toMatchObject({ delivered: 0, failed: 1 });
      expect(paths).toEqual(["/agentmemory/observe"]);
      expect((await readdir(codex)).sort()).toEqual(["end.json", "observe.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps terminal end behind every bounded slice of its observations", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-terminal-slice-"));
    const codex = join(root, "codex");
    const paths: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      paths.push(`${path}:${JSON.parse(String(init?.body || "{}")).captureId || "end"}`);
      return new Response(
        path.endsWith("/observe") ? JSON.stringify({ observationId: "accepted" }) : "{}",
        { status: path.endsWith("/observe") ? 201 : 200 },
      );
    });

    try {
      for (let index = 0; index < 3; index++) {
        await writeEnvelope(codex, `${index}-observe.json`, {
          schemaVersion: 2,
          path: "/agentmemory/observe",
          body: { captureId: `codex:current-${index}`, sessionId: "current-session" },
          createdAt: `2026-08-30T00:00:0${index}.000Z`,
        });
      }
      await writeEnvelope(codex, "3-end.json", {
        schemaVersion: 2,
        priority: "terminal",
        path: "/agentmemory/session/end",
        body: { sessionId: "current-session" },
        createdAt: "2026-08-30T00:00:03.000Z",
      });

      const first = await replayConnectorOutboxes({
        outboxes: [{ adapter: "codex", dir: codex }],
        baseUrl: "http://127.0.0.1:3111",
        fetchImpl: fetchMock,
        timeoutMs: 50,
        limit: 2,
      });
      expect(first).toMatchObject({ delivered: 2, newlyAccepted: 2, failed: 0 });
      expect(paths).toEqual([
        "/agentmemory/observe:codex:current-0",
        "/agentmemory/observe:codex:current-1",
      ]);
      expect((await readdir(codex)).sort()).toEqual(["2-observe.json", "3-end.json"]);

      const second = await replayConnectorOutboxes({
        outboxes: [{ adapter: "codex", dir: codex }],
        baseUrl: "http://127.0.0.1:3111",
        fetchImpl: fetchMock,
        timeoutMs: 50,
        limit: 2,
      });
      expect(second).toMatchObject({ delivered: 2, newlyAccepted: 2, failed: 0 });
      expect(paths.slice(2)).toEqual([
        "/agentmemory/observe:codex:current-2",
        "/agentmemory/session/end:end",
      ]);
      expect(await readdir(codex)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("chooses the oldest terminal-priority group across adapters", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-terminal-fair-"));
    const codex = join(root, "codex");
    const hermes = join(root, "hermes");
    const sessions: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      sessions.push(JSON.parse(String(init?.body || "{}")).sessionId);
      return new Response("{}", { status: 200 });
    });

    try {
      await writeEnvelope(codex, "end.json", {
        schemaVersion: 2,
        priority: "terminal",
        path: "/agentmemory/session/end",
        body: { sessionId: "codex-newer" },
        createdAt: "2026-08-30T00:00:02.000Z",
      });
      await writeEnvelope(hermes, "end.json", {
        schemaVersion: 2,
        priority: "terminal",
        path: "/agentmemory/session/end",
        body: { sessionId: "hermes-older" },
        createdAt: "2026-08-30T00:00:01.000Z",
      });

      const first = await replayConnectorOutboxes({
        outboxes: [
          { adapter: "codex", dir: codex },
          { adapter: "hermes", dir: hermes },
        ],
        baseUrl: "http://127.0.0.1:3111",
        fetchImpl: fetchMock,
        timeoutMs: 50,
        limit: 20,
      });
      expect(first).toMatchObject({ delivered: 1, failed: 0 });
      expect(sessions).toEqual(["hermes-older"]);
      expect(await readdir(codex)).toEqual(["end.json"]);
      expect(await readdir(hermes)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replays same-session predecessors across adapters before terminal end", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-terminal-cross-adapter-"));
    const codex = join(root, "codex");
    const hermes = join(root, "hermes");
    const paths: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      paths.push(`${new URL(String(url)).pathname}:${body.captureId || "end"}`);
      return new Response(
        new URL(String(url)).pathname.endsWith("/observe")
          ? JSON.stringify({ observationId: body.captureId })
          : "{}",
        { status: new URL(String(url)).pathname.endsWith("/observe") ? 201 : 200 },
      );
    });

    try {
      await writeEnvelope(hermes, "observe.json", {
        schemaVersion: 2,
        path: "/agentmemory/observe",
        body: { captureId: "hermes:current-observe", sessionId: "shared-session" },
        createdAt: "2026-08-30T00:00:00.000Z",
      });
      await writeEnvelope(codex, "end.json", {
        schemaVersion: 2,
        priority: "terminal",
        path: "/agentmemory/session/end",
        body: { sessionId: "shared-session" },
        createdAt: "2026-08-30T00:00:01.000Z",
      });

      const result = await replayConnectorOutboxes({
        outboxes: [
          { adapter: "hermes", dir: hermes },
          { adapter: "codex", dir: codex },
        ],
        baseUrl: "http://127.0.0.1:3111",
        fetchImpl: fetchMock,
        timeoutMs: 50,
        limit: 20,
      });

      expect(result).toMatchObject({ delivered: 2, failed: 0 });
      expect(paths).toEqual([
        "/agentmemory/observe:hermes:current-observe",
        "/agentmemory/session/end:end",
      ]);
      expect(await readdir(hermes)).toEqual([]);
      expect(await readdir(codex)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores cross-adapter predecessors and terminal end after a predecessor failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-terminal-cross-adapter-failure-"));
    const codex = join(root, "codex");
    const hermes = join(root, "hermes");
    const paths: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return path.endsWith("/observe")
        ? new Response("unavailable", { status: 503 })
        : new Response("{}", { status: 200 });
    });

    try {
      await writeEnvelope(hermes, "observe.json", {
        schemaVersion: 2,
        path: "/agentmemory/observe",
        body: { captureId: "hermes:failed-observe", sessionId: "shared-session" },
        createdAt: "2026-08-30T00:00:00.000Z",
      });
      await writeEnvelope(codex, "end.json", {
        schemaVersion: 2,
        priority: "terminal",
        path: "/agentmemory/session/end",
        body: { sessionId: "shared-session" },
        createdAt: "2026-08-30T00:00:01.000Z",
      });

      const result = await replayConnectorOutboxes({
        outboxes: [
          { adapter: "hermes", dir: hermes },
          { adapter: "codex", dir: codex },
        ],
        baseUrl: "http://127.0.0.1:3111",
        fetchImpl: fetchMock,
        timeoutMs: 50,
        limit: 20,
      });

      expect(result).toMatchObject({ delivered: 0, failed: 1 });
      expect(paths).toEqual(["/agentmemory/observe"]);
      expect(await readdir(hermes)).toEqual(["observe.json"]);
      expect(await readdir(codex)).toEqual(["end.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves a cross-adapter terminal end pending until its bounded predecessors drain", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-terminal-cross-adapter-slice-"));
    const codex = join(root, "codex");
    const hermes = join(root, "hermes");
    const paths: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      const path = new URL(String(url)).pathname;
      paths.push(`${path}:${body.captureId || "end"}`);
      return new Response(
        path.endsWith("/observe") ? JSON.stringify({ observationId: body.captureId }) : "{}",
        { status: path.endsWith("/observe") ? 201 : 200 },
      );
    });

    try {
      for (const [index, captureId] of [
        "hermes:current-0",
        "hermes:current-1",
      ].entries()) {
        await writeEnvelope(hermes, `${index}-observe.json`, {
          schemaVersion: 2,
          path: "/agentmemory/observe",
          body: { captureId, sessionId: "shared-session" },
          createdAt: `2026-08-30T00:00:0${index}.000Z`,
        });
      }
      await writeEnvelope(codex, "end.json", {
        schemaVersion: 2,
        priority: "terminal",
        path: "/agentmemory/session/end",
        body: { sessionId: "shared-session" },
        createdAt: "2026-08-30T00:00:02.000Z",
      });

      const first = await replayConnectorOutboxes({
        outboxes: [
          { adapter: "hermes", dir: hermes },
          { adapter: "codex", dir: codex },
        ],
        baseUrl: "http://127.0.0.1:3111",
        fetchImpl: fetchMock,
        timeoutMs: 50,
        limit: 2,
      });
      expect(first).toMatchObject({ delivered: 2, failed: 0 });
      expect(paths).toEqual([
        "/agentmemory/observe:hermes:current-0",
        "/agentmemory/observe:hermes:current-1",
      ]);
      expect(await readdir(hermes)).toEqual([]);
      expect(await readdir(codex)).toEqual(["end.json"]);

      const second = await replayConnectorOutboxes({
        outboxes: [
          { adapter: "hermes", dir: hermes },
          { adapter: "codex", dir: codex },
        ],
        baseUrl: "http://127.0.0.1:3111",
        fetchImpl: fetchMock,
        timeoutMs: 50,
        limit: 2,
      });
      expect(second).toMatchObject({ delivered: 1, failed: 0 });
      expect(paths.slice(2)).toEqual(["/agentmemory/session/end:end"]);
      expect(await readdir(codex)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an observe envelope pending when a 2xx body reports rejection", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-body-rejection-"));
    const codex = join(root, "codex");
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: false,
          error: "Session observation limit reached (500)",
        }),
        { status: 201 },
      ),
    );

    try {
      await writeEnvelope(codex, "rejected.json", {
        schemaVersion: 2,
        path: "/agentmemory/observe",
        body: { captureId: "codex:must-not-be-deleted" },
      });

      const result = await replayConnectorOutboxes({
        outboxes: [{ adapter: "codex", dir: codex }],
        baseUrl: "http://127.0.0.1:3111",
        fetchImpl: fetchMock,
        timeoutMs: 50,
        limit: 1,
      });

      expect(result).toMatchObject({ delivered: 0, failed: 1 });
      expect(await readdir(codex)).toEqual(["rejected.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drains accepted duplicate captures but stops after the first newly accepted current envelope", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-adaptive-"));
    const codex = join(root, "codex");
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      const duplicate = body.captureId === "codex:duplicate-1" ||
        body.captureId === "codex:duplicate-2";
      return new Response(
        JSON.stringify(duplicate
          ? { observationId: body.captureId, deduplicated: true }
          : { observationId: body.captureId }),
        { status: 201 },
      );
    });

    try {
      const captureIds = [
        "codex:duplicate-1",
        "codex:duplicate-2",
        "codex:new-1",
        "codex:must-remain",
      ];
      for (const [index, captureId] of captureIds.entries()) {
        await writeEnvelope(codex, `${index}.json`, {
          schemaVersion: 2,
          path: "/agentmemory/observe",
          body: { captureId },
          createdAt: `2026-08-30T00:00:0${index}.000Z`,
        });
      }

      const result = await replayConnectorOutboxes({
        outboxes: [{ adapter: "codex", dir: codex }],
        baseUrl: "http://127.0.0.1:3111",
        fetchImpl: fetchMock,
        timeoutMs: 50,
        limit: 20,
      });

      expect(result).toMatchObject({
        delivered: 3,
        deduplicated: 2,
        newlyAccepted: 1,
        failed: 0,
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(await readdir(codex)).toEqual(["3.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("counts missing projection recovery separately and stops the current tick", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-projection-recovery-"));
    const codex = join(root, "codex");
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      return new Response(JSON.stringify(
        body.captureId === "codex:missing-projection"
          ? { deduplicated: true, projectionQueued: true }
          : { deduplicated: true },
      ), { status: 201 });
    });

    try {
      await writeEnvelope(codex, "0.json", {
        schemaVersion: 2,
        path: "/agentmemory/observe",
        body: { captureId: "codex:missing-projection" },
        createdAt: "2026-08-30T00:00:00.000Z",
      });
      await writeEnvelope(codex, "1.json", {
        schemaVersion: 2,
        path: "/agentmemory/observe",
        body: { captureId: "codex:accepted-duplicate" },
        createdAt: "2026-08-30T00:00:01.000Z",
      });

      const result = await replayConnectorOutboxes({
        outboxes: [{ adapter: "codex", dir: codex }],
        baseUrl: "http://127.0.0.1:3111",
        fetchImpl: fetchMock,
        timeoutMs: 50,
        limit: 20,
      });

      expect(result).toMatchObject({
        delivered: 1,
        deduplicated: 0,
        newlyAccepted: 0,
        projectionQueued: 1,
        failed: 0,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await readdir(codex)).toEqual(["1.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers interrupted claims and reports malformed envelopes without deleting them", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-claim-"));
    const codex = join(root, "codex");

    try {
      await writeEnvelope(codex, "interrupted.json.replaying", {
        schemaVersion: 2,
        path: "/agentmemory/observe",
        body: { captureId: "codex:interrupted" },
      });
      await mkdir(codex, { recursive: true });
      await writeFile(join(codex, "malformed.json"), "{not-json", "utf8");

      expect(await recoverConnectorOutboxClaims([{ adapter: "codex", dir: codex }])).toBe(1);
      expect(await readdir(codex)).toEqual(["interrupted.json", "malformed.json"]);
      const inspection = await inspectConnectorOutboxes([
        { adapter: "codex", dir: codex },
      ]);
      expect(inspection).toMatchObject({ current: 1, legacy: 0, malformed: 1, claimed: 0 });
      expect(await readFile(join(codex, "malformed.json"), "utf8")).toBe("{not-json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("registers an operator replay capped at twenty legacy envelopes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-legacy-cap-"));
    const codex = join(root, "codex");
    const sdk = mockSdk();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));

    try {
      for (let index = 0; index < 21; index++) {
        await writeEnvelope(codex, `${String(index).padStart(2, "0")}.json`, {
          path: "/agentmemory/observe",
          body: { captureId: `codex:legacy-${index}` },
          createdAt: `2026-08-30T00:00:${String(index).padStart(2, "0")}.000Z`,
        });
      }
      registerConnectorOutboxReplayFunctions(sdk as never, {
        outboxes: [{ adapter: "codex", dir: codex }],
        baseUrl: "http://127.0.0.1:3111",
        fetchImpl: fetchMock,
        timeoutMs: 50,
      });

      const result = (await sdk.trigger("mem::connector-outbox-replay", {
        mode: "legacy",
        limit: 100,
      })) as { delivered: number };
      expect(result.delivered).toBe(20);
      expect(fetchMock).toHaveBeenCalledTimes(20);
      expect(await readdir(codex)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits one interval and replays one envelope per non-overlapping automatic tick", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    let active = 0;
    let maxActive = 0;
    const payloads: unknown[] = [];
    const sdk = {
      trigger: vi.fn(async (request: { payload?: unknown }) => {
        payloads.push(request.payload);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        active -= 1;
      }),
    };

    try {
      const loop = startConnectorOutboxReplayLoop(sdk as never);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(payloads).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(payloads).toEqual([{ limit: 20 }]);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(payloads).toEqual([{ limit: 20 }]);
      expect(maxActive).toBe(1);

      release?.();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(payloads).toEqual([{ limit: 20 }, { limit: 20 }]);
      expect(maxActive).toBe(1);
      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays automatic envelopes despite a legacy projection gate callback", async () => {
    vi.useFakeTimers();
    const sdk = { trigger: vi.fn(async () => ({ success: true })) };
    const canReplay = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValue(false);

    try {
      const legacyStart = startConnectorOutboxReplayLoop as unknown as (
        sdk: never,
        intervalMs: number,
        canReplay: () => Promise<boolean>,
      ) => { stop(): void };
      const loop = legacyStart(
        sdk as never,
        30_000,
        canReplay,
      );

      await vi.advanceTimersByTimeAsync(30_000);
      expect(sdk.trigger).toHaveBeenCalledTimes(1);
      expect(sdk.trigger).toHaveBeenCalledWith({
        function_id: "mem::connector-outbox-replay",
        payload: { limit: 20 },
      });
      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });
  it("parses only the oldest bounded window when the backlog exceeds the scan limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-scanlimit-"));
    const codex = join(root, "codex");
    try {
      // Names sort in the reverse of mtime order, so a directory-order window
      // would select the newest envelopes instead of the oldest ones.
      const total = 12;
      for (let index = 0; index < total; index += 1) {
        const name = `${String.fromCharCode(122 - index)}-${index}.json`;
        await writeEnvelope(codex, name, {
          schemaVersion: 2,
          path: "observe",
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
          body: { captureId: `codex:${index}` },
        });
        const when = new Date(Date.UTC(2026, 0, 1, 0, index));
        await utimes(join(codex, name), when, when);
      }

      const calls: unknown[] = [];
      const result = await replayConnectorOutboxes({
        outboxes: [{ adapter: "codex", dir: codex }],
        baseUrl: "http://127.0.0.1:5611",
        limit: 1,
        scanLimit: 3,
        fetchImpl: (async (_url: string, init: { body: string }) => {
          calls.push(JSON.parse(init.body));
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }) as unknown as typeof fetch,
      });

      expect(result).toMatchObject({
        pending: total,
        scanned: 3,
        truncated: true,
        current: 3,
        delivered: 1,
        newlyAccepted: 1,
      });
      expect(calls).toEqual([{ captureId: "codex:0" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an untruncated scan when the backlog fits the scan limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-untruncated-"));
    const codex = join(root, "codex");
    try {
      for (let index = 0; index < 3; index += 1) {
        await writeEnvelope(codex, `e${index}.json`, {
          schemaVersion: 2,
          path: "observe",
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
          body: { captureId: `codex:${index}` },
        });
      }

      const inspection = await inspectConnectorOutboxes([
        { adapter: "codex", dir: codex },
      ]);

      expect(inspection).toMatchObject({
        pending: 3,
        scanned: 3,
        truncated: false,
        current: 3,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("skips past an undeliverable oldest prefix instead of starving on it", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-starve-"));
    const codex = join(root, "codex");
    try {
      // Eight legacy envelopes are the oldest; nothing ever deletes them in
      // current mode, so a fixed oldest-N window would deliver nothing forever.
      for (let index = 0; index < 8; index += 1) {
        const name = `legacy-${index}.json`;
        await writeEnvelope(codex, name, {
          schemaVersion: 1,
          path: "observe",
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
          body: { captureId: `legacy:${index}` },
        });
        const when = new Date(Date.UTC(2026, 0, 1, 0, index));
        await utimes(join(codex, name), when, when);
      }
      for (let index = 0; index < 2; index += 1) {
        const name = `current-${index}.json`;
        await writeEnvelope(codex, name, {
          schemaVersion: 2,
          path: "observe",
          createdAt: new Date(Date.UTC(2026, 0, 1, 1, index)).toISOString(),
          body: { captureId: `current:${index}` },
        });
        const when = new Date(Date.UTC(2026, 0, 1, 1, index));
        await utimes(join(codex, name), when, when);
      }

      const calls: unknown[] = [];
      const result = await replayConnectorOutboxes({
        outboxes: [{ adapter: "codex", dir: codex }],
        baseUrl: "http://127.0.0.1:5611",
        limit: 1,
        scanLimit: 5,
        fetchImpl: (async (_url: string, init: { body: string }) => {
          calls.push(JSON.parse(init.body));
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }) as unknown as typeof fetch,
      });

      expect(result).toMatchObject({ pending: 10, delivered: 1, newlyAccepted: 1 });
      expect(calls).toEqual([{ captureId: "current:0" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never ships a terminal end whose predecessors fell outside another adapter's window", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-crossadapter-"));
    const codex = join(root, "codex");
    const hermes = join(root, "hermes");
    try {
      // codex is the busy adapter: an old unrelated backlog, then the tracked
      // session's observations. hermes holds only that session's terminal end.
      for (let index = 0; index < 8; index += 1) {
        const name = `other-${index}.json`;
        await writeEnvelope(codex, name, {
          schemaVersion: 2,
          path: "observe",
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
          body: { captureId: `other:${index}`, sessionId: "other-session" },
        });
        const when = new Date(Date.UTC(2026, 0, 1, 0, index));
        await utimes(join(codex, name), when, when);
      }
      for (let index = 0; index < 3; index += 1) {
        const name = `tracked-${index}.json`;
        await writeEnvelope(codex, name, {
          schemaVersion: 2,
          path: "observe",
          createdAt: new Date(Date.UTC(2026, 0, 1, 1, index)).toISOString(),
          body: { captureId: `tracked:${index}`, sessionId: "tracked-session" },
        });
        const when = new Date(Date.UTC(2026, 0, 1, 1, index));
        await utimes(join(codex, name), when, when);
      }
      await writeEnvelope(hermes, "end.json", {
        schemaVersion: 2,
        priority: "terminal",
        path: "session/end",
        createdAt: new Date(Date.UTC(2026, 0, 1, 2, 0)).toISOString(),
        body: { sessionId: "tracked-session" },
      });
      const endAt = new Date(Date.UTC(2026, 0, 1, 2, 0));
      await utimes(join(hermes, "end.json"), endAt, endAt);

      const paths: string[] = [];
      await replayConnectorOutboxes({
        outboxes: [
          { adapter: "codex", dir: codex },
          { adapter: "hermes", dir: hermes },
        ],
        baseUrl: "http://127.0.0.1:5611",
        limit: 4,
        scanLimit: 5,
        fetchImpl: (async (url: string) => {
          paths.push(new URL(url).pathname);
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }) as unknown as typeof fetch,
      });

      expect(paths).not.toContain("/agentmemory/session/end");
      expect(await readdir(hermes)).toEqual(["end.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("resolves the scan limit from the argument, then the environment, then the default", () => {
    expect(resolveOutboxScanLimit(undefined, {})).toBe(500);
    expect(resolveOutboxScanLimit(undefined, { AGENTMEMORY_OUTBOX_SCAN_LIMIT: "120" })).toBe(120);
    expect(resolveOutboxScanLimit(7, { AGENTMEMORY_OUTBOX_SCAN_LIMIT: "120" })).toBe(7);
    expect(resolveOutboxScanLimit(0, { AGENTMEMORY_OUTBOX_SCAN_LIMIT: "120" })).toBe(0);
    expect(resolveOutboxScanLimit(-1, {})).toBe(500);
    expect(resolveOutboxScanLimit(Number.NaN, {})).toBe(500);
    expect(resolveOutboxScanLimit(undefined, { AGENTMEMORY_OUTBOX_SCAN_LIMIT: "nope" })).toBe(500);
    expect(resolveOutboxScanLimit(4.9, {})).toBe(4);
  });
  it("never ships a terminal end while the scan is truncated", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-truncated-terminal-"));
    const codex = join(root, "codex");
    try {
      // mtime rank and createdAt rank disagree for obs-c: it is written last but
      // is an earlier predecessor, so an mtime window can exclude it while
      // admitting the session end that must not precede it.
      const write = async (
        name: string,
        value: Record<string, unknown>,
        mtime: Date,
      ) => {
        await writeEnvelope(codex, name, value);
        await utimes(join(codex, name), mtime, mtime);
      };
      await write("a.json", {
        schemaVersion: 2,
        path: "observe",
        createdAt: "2026-01-01T01:00:00.000Z",
        body: { captureId: "a", sessionId: "S" },
      }, new Date(Date.UTC(2026, 0, 1, 1, 0)));
      await write("b.json", {
        schemaVersion: 2,
        path: "observe",
        createdAt: "2026-01-01T01:01:00.000Z",
        body: { captureId: "b", sessionId: "S" },
      }, new Date(Date.UTC(2026, 0, 1, 1, 1)));
      await write("end.json", {
        schemaVersion: 2,
        priority: "terminal",
        path: "session/end",
        createdAt: "2026-01-01T02:00:00.000Z",
        body: { sessionId: "S" },
      }, new Date(Date.UTC(2026, 0, 1, 2, 0)));
      await write("c.json", {
        schemaVersion: 2,
        path: "observe",
        createdAt: "2026-01-01T01:02:00.000Z",
        body: { captureId: "c", sessionId: "S" },
      }, new Date(Date.UTC(2026, 0, 1, 3, 0)));

      const paths: string[] = [];
      const result = await replayConnectorOutboxes({
        outboxes: [{ adapter: "codex", dir: codex }],
        baseUrl: "http://127.0.0.1:5611",
        limit: 4,
        // Two slots stop the scan before obs-c, whose write time is newest even
        // though its createdAt makes it an earlier predecessor of the end.
        scanLimit: 2,
        fetchImpl: (async (url: string) => {
          paths.push(new URL(url).pathname);
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }) as unknown as typeof fetch,
      });

      expect(result.truncated).toBe(true);
      expect(paths).not.toContain("/agentmemory/session/end");
      expect(await readdir(codex)).toContain("end.json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("counts every legacy envelope it scanned, not just the ones it retained", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-legacycount-"));
    const codex = join(root, "codex");
    try {
      for (let index = 0; index < 9; index += 1) {
        const name = `legacy-${index}.json`;
        await writeEnvelope(codex, name, {
          schemaVersion: 1,
          path: "observe",
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
          body: { captureId: `legacy:${index}` },
        });
        const when = new Date(Date.UTC(2026, 0, 1, 0, index));
        await utimes(join(codex, name), when, when);
      }

      const result = await replayConnectorOutboxes({
        outboxes: [{ adapter: "codex", dir: codex }],
        baseUrl: "http://127.0.0.1:5611",
        limit: 1,
        scanLimit: 2,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ success: true }), { status: 200 })) as unknown as typeof fetch,
      });

      expect(result).toMatchObject({ pending: 9, scanned: 9, legacy: 9, delivered: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a blank scan-limit environment value as unset", () => {
    expect(resolveOutboxScanLimit(undefined, { AGENTMEMORY_OUTBOX_SCAN_LIMIT: "" })).toBe(500);
    expect(resolveOutboxScanLimit(undefined, { AGENTMEMORY_OUTBOX_SCAN_LIMIT: "   " })).toBe(500);
  });
  it("keeps draining observations when pending session ends outnumber the window", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-endwedge-"));
    const codex = join(root, "codex");
    try {
      const write = async (name: string, value: Record<string, unknown>, minute: number) => {
        await writeEnvelope(codex, name, value);
        const when = new Date(Date.UTC(2026, 0, 1, 0, minute));
        await utimes(join(codex, name), when, when);
      };
      // Six ends are the oldest entries; the window is five.
      for (let index = 0; index < 6; index += 1) {
        await write(`end-${index}.json`, {
          schemaVersion: 2,
          priority: "terminal",
          path: "session/end",
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
          body: { sessionId: `s${index}` },
        }, index);
      }
      for (let index = 0; index < 6; index += 1) {
        await write(`obs-${index}.json`, {
          schemaVersion: 2,
          path: "observe",
          createdAt: new Date(Date.UTC(2026, 0, 1, 1, index)).toISOString(),
          body: { captureId: `obs:${index}`, sessionId: "live" },
        }, 30 + index);
      }

      const paths: string[] = [];
      const result = await replayConnectorOutboxes({
        outboxes: [{ adapter: "codex", dir: codex }],
        baseUrl: "http://127.0.0.1:5611",
        limit: 4,
        scanLimit: 5,
        fetchImpl: (async (url: string) => {
          paths.push(new URL(url).pathname);
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }) as unknown as typeof fetch,
      });

      expect(result.truncated).toBe(true);
      expect(paths).not.toContain("/agentmemory/session/end");
      expect(result.delivered).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("holds a terminal end back only while the scan is incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-endcomplete-"));
    const codex = join(root, "codex");
    try {
      await writeEnvelope(codex, "obs.json", {
        schemaVersion: 2,
        path: "observe",
        createdAt: "2026-01-01T01:00:00.000Z",
        body: { captureId: "a", sessionId: "S" },
      });
      await writeEnvelope(codex, "end.json", {
        schemaVersion: 2,
        priority: "terminal",
        path: "session/end",
        createdAt: "2026-01-01T02:00:00.000Z",
        body: { sessionId: "S" },
      });

      const paths: string[] = [];
      const result = await replayConnectorOutboxes({
        outboxes: [{ adapter: "codex", dir: codex }],
        baseUrl: "http://127.0.0.1:5611",
        limit: 4,
        scanLimit: 500,
        fetchImpl: (async (url: string) => {
          paths.push(new URL(url).pathname);
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }) as unknown as typeof fetch,
      });

      expect(result.truncated).toBe(false);
      expect(paths).toEqual([
        "/agentmemory/observe",
        "/agentmemory/session/end",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stays quiet about undeliverable scans when the outbox is simply empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-quiet-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await replayConnectorOutboxes({
        outboxes: [{ adapter: "codex", dir: join(root, "codex") }],
        baseUrl: "http://127.0.0.1:5611",
        limit: 4,
        fetchImpl: (async () =>
          new Response("{}", { status: 200 })) as unknown as typeof fetch,
      });
      expect(result).toMatchObject({ pending: 0, scanned: 0, truncated: false });
      expect(
        warn.mock.calls.filter(([line]) =>
          String(line).includes("nothing deliverable")
        ),
      ).toEqual([]);
    } finally {
      warn.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("holds a legacy terminal end back while the scan is incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-outbox-legacyend-"));
    const codex = join(root, "codex");
    try {
      const write = async (name: string, value: Record<string, unknown>, minute: number) => {
        await writeEnvelope(codex, name, value);
        const when = new Date(Date.UTC(2026, 0, 1, 0, minute));
        await utimes(join(codex, name), when, when);
      };
      await write("end.json", {
        schemaVersion: 1,
        priority: "terminal",
        path: "session/end",
        createdAt: "2026-01-01T02:00:00.000Z",
        body: { sessionId: "S" },
      }, 0);
      for (let index = 0; index < 4; index += 1) {
        await write(`obs-${index}.json`, {
          schemaVersion: 1,
          path: "observe",
          createdAt: new Date(Date.UTC(2026, 0, 1, 1, index)).toISOString(),
          body: { captureId: `o${index}`, sessionId: "S" },
        }, 10 + index);
      }

      const paths: string[] = [];
      await replayConnectorOutboxes({
        outboxes: [{ adapter: "codex", dir: codex }],
        baseUrl: "http://127.0.0.1:5611",
        limit: 1,
        scanLimit: 1,
        mode: "legacy",
        fetchImpl: (async (url: string) => {
          paths.push(new URL(url).pathname);
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }) as unknown as typeof fetch,
      });

      expect(paths).not.toContain("/agentmemory/session/end");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
