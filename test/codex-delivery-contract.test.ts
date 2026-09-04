import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHookDelivery,
  hookSessionId,
  stableHookCaptureId,
} from "../src/hooks/_delivery.js";

describe("Codex hook durable delivery", () => {
  it("persists terminal priority for a SessionEnd delivery instance", async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), "agentmemory-codex-terminal-"));
    const delivery = createHookDelivery({
      outboxDir,
      priority: "terminal",
      fetchImpl: vi.fn(async () => new Response("offline", { status: 503 })),
    });

    try {
      expect(
        await delivery.deliver("/agentmemory/session/end", {
          sessionId: "terminal-session",
        }),
      ).toBe(0);
      const pending = await readdir(outboxDir);
      expect(pending).toHaveLength(1);
      expect(JSON.parse(await readFile(join(outboxDir, pending[0]), "utf8"))).toMatchObject({
        schemaVersion: 2,
        priority: "terminal",
        path: "/agentmemory/session/end",
        body: { sessionId: "terminal-session" },
      });
    } finally {
      await rm(outboxDir, { recursive: true, force: true });
    }
  });

  it("loads transport config from the canonical env file when the hook runner does not inherit it", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentmemory-codex-env-"));
    const outboxDir = join(home, "outbox");
    const expectedUrl = "http://agentmemory-from-file.test";
    const expectedSecret = "secret-from-file";
    const originalHome = process.env["HOME"];
    const originalUserProfile = process.env["USERPROFILE"];
    const originalUrl = process.env["AGENTMEMORY_URL"];
    const originalSecret = process.env["AGENTMEMORY_SECRET"];
    await mkdir(join(home, ".agentmemory"), { recursive: true });
    await writeFile(
      join(home, ".agentmemory", ".env"),
      `AGENTMEMORY_URL=${expectedUrl}\nAGENTMEMORY_SECRET=${expectedSecret}\n`,
    );
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      String(url) === `${expectedUrl}/agentmemory/observe` &&
        (init?.headers as Record<string, string> | undefined)?.Authorization ===
          `Bearer ${expectedSecret}`
        ? new Response(JSON.stringify({ success: true }), { status: 201 })
        : new Response("unauthorized", { status: 401 })
    );

    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
    delete process.env["AGENTMEMORY_URL"];
    delete process.env["AGENTMEMORY_SECRET"];

    try {
      const delivery = createHookDelivery({ outboxDir, fetchImpl: fetchMock });
      expect(await delivery.deliver("/agentmemory/observe", {
        captureId: "codex:file-config",
        sessionId: "codex-file-config",
      })).toBe(1);
      expect(await readdir(outboxDir)).toEqual([]);
    } finally {
      if (originalHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHome;
      if (originalUserProfile === undefined) delete process.env["USERPROFILE"];
      else process.env["USERPROFILE"] = originalUserProfile;
      if (originalUrl === undefined) delete process.env["AGENTMEMORY_URL"];
      else process.env["AGENTMEMORY_URL"] = originalUrl;
      if (originalSecret === undefined) delete process.env["AGENTMEMORY_SECRET"];
      else process.env["AGENTMEMORY_SECRET"] = originalSecret;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("spools HTTP rejection without the bearer secret and replays on 2xx", async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), "agentmemory-codex-"));
    let healthy = false;
    const fetchMock = vi.fn(async () =>
      healthy
        ? new Response(JSON.stringify({ success: true }), { status: 201 })
        : new Response("rejected", { status: 503 }),
    );
    const delivery = createHookDelivery({
      restUrl: "http://localhost:3111",
      secret: "must-not-be-written",
      outboxDir,
      fetchImpl: fetchMock,
      timeoutMs: 50,
    });

    try {
      await delivery.deliver("/agentmemory/observe", {
        captureId: "codex:stable-1",
        sessionId: "codex-session-1",
        data: { prompt: "durable payload" },
      });
      const pending = await readdir(outboxDir);
      expect(pending).toHaveLength(1);
      const stored = await readFile(join(outboxDir, pending[0]), "utf8");
      expect(stored).toContain("durable payload");
      expect(stored).not.toContain("must-not-be-written");

      healthy = true;
      expect(await delivery.replay()).toBe(1);
      expect(await readdir(outboxDir)).toEqual([]);
    } finally {
      await rm(outboxDir, { recursive: true, force: true });
    }
  });

  it("derives the same capture ID from the same Codex event locator", () => {
    expect(stableHookCaptureId("codex-session-2", "tool", "call-9")).toBe(
      stableHookCaptureId("codex-session-2", "tool", "call-9"),
    );
    expect(stableHookCaptureId("codex-session-2", "tool", "call-9")).toMatch(/^codex:/);
    expect(hookSessionId({})).toBeNull();
  });

  it("coalesces repeated capture IDs and replays envelopes oldest first", async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), "agentmemory-codex-order-"));
    let healthy = false;
    const delivered: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      if (healthy) delivered.push(body.captureId);
      return healthy
        ? new Response("{}", { status: 200 })
        : new Response("rejected", { status: 503 });
    });
    const delivery = createHookDelivery({
      outboxDir,
      fetchImpl: fetchMock,
      timeoutMs: 50,
    });

    try {
      await delivery.deliver("/agentmemory/observe", {
        captureId: "codex:first",
        sessionId: "codex-session-order",
        timestamp: "2026-08-28T00:00:00.000Z",
      });
      await delivery.deliver("/agentmemory/observe", {
        captureId: "codex:first",
        sessionId: "codex-session-order",
        timestamp: "2026-08-28T00:00:01.000Z",
      });
      expect(await readdir(outboxDir)).toHaveLength(1);
      await delivery.deliver("/agentmemory/observe", {
        captureId: "codex:second",
        sessionId: "codex-session-order",
        timestamp: "2026-08-28T00:00:02.000Z",
      });
      expect(await readdir(outboxDir)).toHaveLength(2);

      healthy = true;
      expect(await delivery.replay()).toBe(2);
      expect(delivered).toEqual(["codex:first", "codex:second"]);
    } finally {
      await rm(outboxDir, { recursive: true, force: true });
    }
  });

  it("delivers the current envelope without waiting behind an older failure", async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), "agentmemory-codex-current-"));
    const delivered: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      if (body.captureId === "codex:old") {
        return new Response("still unavailable", { status: 503 });
      }
      delivered.push(body.captureId);
      return new Response("{}", { status: 201 });
    });
    const delivery = createHookDelivery({
      outboxDir,
      fetchImpl: fetchMock,
      timeoutMs: 50,
    });

    try {
      expect(await delivery.deliver("/agentmemory/observe", {
        captureId: "codex:old",
        sessionId: "codex-session-old",
      })).toBe(0);
      expect(await delivery.deliver("/agentmemory/observe", {
        captureId: "codex:current",
        sessionId: "codex-session-current",
      })).toBe(1);

      expect(delivered).toEqual(["codex:current"]);
      const pending = await readdir(outboxDir);
      expect(pending).toHaveLength(1);
      const stored = JSON.parse(
        await readFile(join(outboxDir, pending[0]), "utf8"),
      );
      expect(stored).toMatchObject({
        schemaVersion: 2,
        body: { captureId: "codex:old" },
      });
    } finally {
      await rm(outboxDir, { recursive: true, force: true });
    }
  });

  it("replays only the batch queued by the current hook instance", async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), "agentmemory-codex-batch-"));
    const delivered: Array<{ path: string; sessionId: string }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      const path = new URL(url).pathname;
      if (body.sessionId === "older-session") {
        return new Response("still unavailable", { status: 503 });
      }
      delivered.push({ path, sessionId: body.sessionId });
      return new Response("{}", { status: 201 });
    });
    const delivery = createHookDelivery({
      outboxDir,
      fetchImpl: fetchMock,
      timeoutMs: 50,
    });

    try {
      expect(await delivery.deliver("/agentmemory/observe", {
        captureId: "codex:older",
        sessionId: "older-session",
      })).toBe(0);
      await delivery.enqueue("/agentmemory/observe", {
        captureId: "codex:current",
        sessionId: "current-session",
      });
      await delivery.enqueue("/agentmemory/session/end", {
        sessionId: "current-session",
      });

      expect(await delivery.replayQueuedFor(1_000)).toBe(2);
      expect(delivered).toEqual([
        { path: "/agentmemory/observe", sessionId: "current-session" },
        { path: "/agentmemory/session/end", sessionId: "current-session" },
      ]);
      const pending = await readdir(outboxDir);
      expect(pending).toHaveLength(1);
      const stored = JSON.parse(
        await readFile(join(outboxDir, pending[0]), "utf8"),
      );
      expect(stored).toMatchObject({ body: { sessionId: "older-session" } });
    } finally {
      await rm(outboxDir, { recursive: true, force: true });
    }
  });

  it("upgrades legacy session/start only while transmitting so it cannot block replay", async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), "agentmemory-codex-legacy-start-"));
    let healthy = false;
    const delivered: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      const path = new URL(url).pathname;
      if (!healthy) return new Response("rejected", { status: 503 });
      if (
        path === "/agentmemory/session/start" &&
        body.includeContext !== false
      ) {
        return new Response("slow context path", { status: 504 });
      }
      delivered.push({ path, body });
      return new Response("{}", { status: 200 });
    });
    const delivery = createHookDelivery({
      outboxDir,
      fetchImpl: fetchMock,
      timeoutMs: 50,
    });

    try {
      await delivery.deliver("/agentmemory/session/start", {
        sessionId: "codex-session-legacy-start",
        project: "agentmemory",
        cwd: "/work/agentmemory",
      });
      await delivery.deliver("/agentmemory/observe", {
        captureId: "codex:after-legacy-start",
        sessionId: "codex-session-legacy-start",
      });
      await delivery.deliver("/agentmemory/session/end", {
        sessionId: "codex-session-legacy-start",
      });

      const pending = await readdir(outboxDir);
      expect(pending).toHaveLength(3);
      const stored = await Promise.all(
        pending.map(async (name) =>
          JSON.parse(await readFile(join(outboxDir, name), "utf8")),
        ),
      );
      expect(
        stored.find((envelope) => envelope.path === "/agentmemory/session/start")
          ?.body,
      ).not.toHaveProperty("includeContext");

      healthy = true;
      expect(await delivery.replay()).toBe(3);
      expect(delivered.map(({ path }) => path)).toEqual([
        "/agentmemory/session/start",
        "/agentmemory/observe",
        "/agentmemory/session/end",
      ]);
      expect(delivered[0].body).toMatchObject({ includeContext: false });
      expect(await readdir(outboxDir)).toEqual([]);
    } finally {
      await rm(outboxDir, { recursive: true, force: true });
    }
  });
});
