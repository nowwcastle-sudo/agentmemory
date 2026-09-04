import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemWatcher, configFromEnv } from "../integrations/filesystem-watcher/watcher.mjs";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "fs-watch-"));
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function outboxFiles(path: string): string[] {
  try {
    return readdirSync(path)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => join(path, name));
  } catch {
    return [];
  }
}

function outboxBodies(path: string): Array<Record<string, unknown>> {
  return outboxFiles(path).map((file) =>
    (JSON.parse(readFileSync(file, "utf8")) as { body: Record<string, unknown> }).body
  );
}

describe("FilesystemWatcher", { retry: 2 }, () => {
  let root: string;
  let outbox: string;
  const originalFetch = globalThis.fetch;
  const originalOutboxDir = process.env.AGENTMEMORY_OUTBOX_DIR;
  let captured: Array<{ url: string; body: unknown; headers: Record<string, string> }>;

  beforeEach(() => {
    root = tempDir();
    outbox = tempDir();
    process.env.AGENTMEMORY_OUTBOX_DIR = outbox;
    captured = [];
    (globalThis as { fetch: typeof fetch }).fetch = (async (
      url: string | URL,
      init?: RequestInit,
    ) => {
      captured.push({
        url: url.toString(),
        body: init?.body ? JSON.parse(init.body as string) : null,
        headers: (init?.headers || {}) as Record<string, string>,
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    if (originalOutboxDir === undefined) delete process.env.AGENTMEMORY_OUTBOX_DIR;
    else process.env.AGENTMEMORY_OUTBOX_DIR = originalOutboxDir;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(outbox, { recursive: true, force: true });
    } catch {}
  });

  it("emits a post_tool_use observation with HookPayload shape on write", async () => {
    const w = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    w.start();
    try {
      writeFileSync(join(root, "notes.md"), "hello world\n");
      await wait(1500);
      expect(captured.length).toBeGreaterThanOrEqual(1);
      const obs = captured[captured.length - 1];
      expect(obs.url).toBe("http://localhost:3111/agentmemory/observe");
      const body = obs.body as {
        hookType: string;
        sessionId: string;
        project: string;
        cwd: string;
        timestamp: string;
        data: {
          changeKind: string;
          files: string[];
          content: string;
          source: string;
          tool_name: string;
          tool_input: { file_path: string };
          tool_output: string;
        };
      };
      expect(body.hookType).toBe("post_tool_use");
      expect(typeof body.sessionId).toBe("string");
      expect(body.sessionId.length).toBeGreaterThan(0);
      expect(typeof body.project).toBe("string");
      expect(body.project.length).toBeGreaterThan(0);
      expect(body.cwd).toBe(root);
      expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(body.data.source).toBe("filesystem-watcher");
      expect(body.data.changeKind).toBe("file_change");
      expect(body.data.files).toContain("notes.md");
      expect(body.data.content).toContain("hello world");
      expect(body.data.tool_name).toBe("Write");
      expect(body.data.tool_input).toEqual({ file_path: "notes.md" });
      expect(body.data.tool_output).toContain("hello world");
    } finally {
      w.stop();
    }
  });

  it("emits changeKind=file_delete when a watched file is removed", async () => {
    writeFileSync(join(root, "old.md"), "bye\n");
    const w = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    w.start();
    try {
      unlinkSync(join(root, "old.md"));
      await wait(1500);
      const deletes = captured.filter(
        (c) => (c.body as { data: { changeKind: string } }).data?.changeKind === "file_delete",
      );
      expect(deletes.length).toBeGreaterThanOrEqual(1);
      const body = deletes[deletes.length - 1].body as {
        data: { tool_name: string; tool_input: { file_path: string }; tool_output: string };
      };
      expect(body.data.tool_name).toBe("Delete");
      expect(body.data.tool_input).toEqual({ file_path: "old.md" });
      expect(body.data.tool_output).toBe("deleted: old.md");
    } finally {
      w.stop();
    }
  });

  it("throws if no watched roots could be attached", () => {
    // Regression: on Linux with Node 24+, fs.watch on a nonexistent path no
    // longer throws synchronously, so the watcher must stat roots itself or a
    // missing root silently counts as attached (caught by the Node 24/26 CI
    // matrix rows).
    const w = new FilesystemWatcher({
      roots: ["/definitely/does/not/exist/xyz123"],
      baseUrl: "http://localhost:3111",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(() => w.start()).toThrow(/could not watch any of the configured roots/);
  });

  it("rejects a root that is a file, not a directory", () => {
    const filePath = join(root, "not-a-dir.txt");
    writeFileSync(filePath, "plain file");
    const w = new FilesystemWatcher({
      roots: [filePath],
      baseUrl: "http://localhost:3111",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(() => w.start()).toThrow(/could not watch any of the configured roots/);
  });

  it("ignores paths that match the default ignore set", async () => {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    const w = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    w.start();
    try {
      writeFileSync(join(root, "node_modules", "ignored.js"), "x");
      await wait(1500);
      const matches = captured.filter((c) =>
        (c.body as { data: { files: string[] } }).data?.files?.some((f) => f.includes("ignored.js")),
      );
      expect(matches).toHaveLength(0);
    } finally {
      w.stop();
    }
  });

  it("attaches Bearer auth when a secret is configured", async () => {
    const w = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      secret: "shhh",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    w.start();
    try {
      writeFileSync(join(root, "secret.md"), "bearer test\n");
      await wait(1500);
      expect(captured.length).toBeGreaterThanOrEqual(1);
      const headers = captured[captured.length - 1].headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer shhh");
    } finally {
      w.stop();
    }
  });

  it("redacts sensitive dotenv preview values before sending observations", async () => {
    writeFileSync(
      join(root, ".env"),
      [
        "OPENAI_API_KEY=sk-test-secret-value",
        "PUBLIC_FLAG=enabled",
        "AUTHORIZATION=Bearer live-token-value",
      ].join("\n"),
    );
    const w = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await w.flush(root, ".env");

    expect(captured).toHaveLength(1);
    const content = (captured[0].body as { data: { content: string } }).data.content;
    expect(content).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(content).toContain("PUBLIC_FLAG=enabled");
    expect(content).toContain("AUTHORIZATION=[REDACTED]");
    expect(content).not.toContain("sk-test-secret-value");
    expect(content).not.toContain("live-token-value");
  });

  it("redacts quoted JSON-style sensitive keys before sending observations", async () => {
    writeFileSync(
      join(root, "settings.json"),
      [
        '{',
        '  "api_key": "json-preview-secret",',
        '  "public_flag": "enabled"',
        '}',
      ].join("\n"),
    );
    const w = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await w.flush(root, "settings.json");

    expect(captured).toHaveLength(1);
    const content = (captured[0].body as { data: { content: string } }).data.content;
    expect(content).toContain('"api_key": [REDACTED]');
    expect(content).toContain('"public_flag": "enabled"');
    expect(content).not.toContain("json-preview-secret");
  });

  it("redacts bearer tokens from regular text previews before sending observations", async () => {
    writeFileSync(join(root, "request.txt"), "Authorization: Bearer plaintext-token-value\n");
    const w = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await w.flush(root, "request.txt");

    expect(captured).toHaveLength(1);
    const content = (captured[0].body as { data: { content: string } }).data.content;
    expect(content).toContain("Authorization: Bearer [REDACTED]");
    expect(content).not.toContain("plaintext-token-value");
  });

  it("collapses multi-line PEM private-key blocks while keeping BEGIN/END markers", async () => {
    const dashes = "-".repeat(5);
    const rsaBegin = `${dashes}BEGIN RSA PRIVATE KEY${dashes}`;
    const rsaEnd = `${dashes}END RSA PRIVATE KEY${dashes}`;
    const sshBegin = `${dashes}BEGIN OPENSSH PRIVATE KEY${dashes}`;
    const sshEnd = `${dashes}END OPENSSH PRIVATE KEY${dashes}`;
    writeFileSync(
      join(root, "id_rsa.txt"),
      [
        rsaBegin,
        "MIIEowIBAAKCAQEAuRFakeRsaBodyLine1ShouldNeverLeakToObservationPipeline",
        "MoreFakeBase64BodyForRsaKeyMaterialThatMustStayRedacted",
        "YetAnotherSecretLineOfBase64KeyContentNoOneShouldRead",
        rsaEnd,
        "",
        sshBegin,
        "b3BlbnNzaC1mYWtlLWtleS1ib2R5LWxpbmUtb25l",
        "b3BlbnNzaC1mYWtlLWtleS1ib2R5LWxpbmUtdHdv",
        sshEnd,
        "",
      ].join("\n"),
    );
    const w = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await w.flush(root, "id_rsa.txt");

    expect(captured).toHaveLength(1);
    const content = (captured[0].body as { data: { content: string } }).data.content;
    expect(content).toContain(rsaBegin);
    expect(content).toContain(rsaEnd);
    expect(content).toContain(sshBegin);
    expect(content).toContain(sshEnd);
    expect(content).toContain("[REDACTED]");
    expect(content).not.toContain("MIIEowIBAAKCAQEAuRFakeRsaBodyLine1");
    expect(content).not.toContain("MoreFakeBase64BodyForRsaKeyMaterial");
    expect(content).not.toContain("YetAnotherSecretLineOfBase64KeyContent");
    expect(content).not.toContain("b3BlbnNzaC1mYWtlLWtleS1ib2R5LWxpbmUtb25l");
    expect(content).not.toContain("b3BlbnNzaC1mYWtlLWtleS1ib2R5LWxpbmUtdHdv");
  });

  it("redacts inline PEM blocks embedded in single-line JSON values", async () => {
    const dashes = "-".repeat(5);
    const pemBegin = `${dashes}BEGIN PRIVATE KEY${dashes}`;
    const pemEnd = `${dashes}END PRIVATE KEY${dashes}`;
    const inlinePem = `${pemBegin}\\nMIIEvgIBADANBgkqhkiG9w0FakeServiceAccountBody\\n${pemEnd}`;
    writeFileSync(
      join(root, "service-account.json"),
      `{\n  "type": "service_account",\n  "private_key": "${inlinePem}",\n  "client_email": "demo@example.com"\n}\n`,
    );
    const w = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await w.flush(root, "service-account.json");

    expect(captured).toHaveLength(1);
    const content = (captured[0].body as { data: { content: string } }).data.content;
    expect(content).toContain(pemBegin);
    expect(content).toContain(pemEnd);
    expect(content).toContain("[REDACTED]");
    expect(content).not.toContain("MIIEvgIBADANBgkqhkiG9w0FakeServiceAccountBody");
    expect(content).toContain('"client_email": "demo@example.com"');
  });

  it("redacts standalone JWT-looking strings outside Bearer context", async () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    writeFileSync(
      join(root, "notes.txt"),
      ["session token below:", jwt, "end of token"].join("\n"),
    );
    const w = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await w.flush(root, "notes.txt");

    expect(captured).toHaveLength(1);
    const content = (captured[0].body as { data: { content: string } }).data.content;
    expect(content).toContain("[REDACTED]");
    expect(content).not.toContain(jwt);
    expect(content).toContain("end of token");
  });

  it("does not redact base64-looking words that are not three-segment JWTs of sufficient length", async () => {
    const notJwt = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const shortThreeSegment = "eyJabc.def.ghi";
    expect(notJwt.length).toBe(62);
    expect(shortThreeSegment.length).toBeLessThan(100);
    writeFileSync(
      join(root, "fixture.txt"),
      ["random base64-ish word:", notJwt, "tiny segmented thing:", shortThreeSegment].join("\n"),
    );
    const w = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await w.flush(root, "fixture.txt");

    expect(captured).toHaveLength(1);
    const content = (captured[0].body as { data: { content: string } }).data.content;
    expect(content).toContain(notJwt);
    expect(content).toContain(shortThreeSegment);
    expect(content).not.toContain("[REDACTED]");
  });

  it("persists a secret-free envelope before a network request can fail", async () => {
    const transportSecret = "watcher-test-transport-secret";
    const previewSecret = "watcher-test-preview-sensitive-value";
    let persistedBeforeFetch = false;
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      persistedBeforeFetch = outboxFiles(outbox).length === 1;
      throw new Error("offline");
    }) as typeof fetch;
    writeFileSync(join(root, ".env"), `ACCESS_TOKEN=${previewSecret}\nPUBLIC_FLAG=enabled\n`);
    const w = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      secret: transportSecret,
      outboxDir: outbox,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await w.flush(root, ".env");

    expect(persistedBeforeFetch).toBe(true);
    const files = outboxFiles(outbox);
    expect(files).toHaveLength(1);
    const serialized = readFileSync(files[0], "utf8");
    expect(serialized).not.toContain(transportSecret);
    expect(serialized).not.toContain(previewSecret);
    const body = (JSON.parse(serialized) as { body: Record<string, unknown> }).body;
    expect(body.captureId).toMatch(/^filesystem-watcher:[0-9a-f-]{36}$/);
  });

  it("keeps an envelope on HTTP 500 and deletes it only after a 2xx acknowledgement", async () => {
    let status = 500;
    let presentDuringAcknowledgement = false;
    (globalThis as { fetch: typeof fetch }).fetch = (async (
      url: string | URL,
      init?: RequestInit,
    ) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      captured.push({
        url: url.toString(),
        body,
        headers: (init?.headers || {}) as Record<string, string>,
      });
      if (status === 200) presentDuringAcknowledgement = outboxFiles(outbox).length === 1;
      return new Response("{}", { status });
    }) as unknown as typeof fetch;
    writeFileSync(join(root, "retry.md"), "retry me\n");
    const w = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      outboxDir: outbox,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await w.flush(root, "retry.md");
    expect(outboxFiles(outbox)).toHaveLength(1);
    const firstCaptureId = (captured[0].body as { captureId: string }).captureId;

    status = 200;
    await w.replay();

    expect(presentDuringAcknowledgement).toBe(true);
    expect(outboxFiles(outbox)).toHaveLength(0);
    expect((captured[1].body as { captureId: string }).captureId).toBe(firstCaptureId);
  });

  it("replays oldest-first and stops before later envelopes after the first failure", async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    writeFileSync(join(root, "first.md"), "first\n");
    writeFileSync(join(root, "second.md"), "second\n");
    const w = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      outboxDir: outbox,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await w.flush(root, "first.md");
    await w.flush(root, "second.md");
    expect(outboxFiles(outbox)).toHaveLength(2);

    captured = [];
    let fail = true;
    (globalThis as { fetch: typeof fetch }).fetch = (async (
      url: string | URL,
      init?: RequestInit,
    ) => {
      captured.push({
        url: url.toString(),
        body: init?.body ? JSON.parse(init.body as string) : null,
        headers: (init?.headers || {}) as Record<string, string>,
      });
      if (fail) return new Response("no", { status: 500 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await w.replay();
    expect(captured.map((entry) => (entry.body as { data: { files: string[] } }).data.files[0]))
      .toEqual(["first.md"]);
    expect(outboxFiles(outbox)).toHaveLength(2);

    captured = [];
    fail = false;
    await w.replay();
    expect(captured.map((entry) => (entry.body as { data: { files: string[] } }).data.files[0]))
      .toEqual(["first.md", "second.md"]);
    expect(outboxFiles(outbox)).toHaveLength(0);
  });

  it("replays persisted backlog on startup without a new filesystem event", async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    writeFileSync(join(root, "startup.md"), "startup replay\n");
    const first = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      outboxDir: outbox,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await first.flush(root, "startup.md");
    first.stop();
    expect(outboxFiles(outbox)).toHaveLength(1);

    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response("{}", { status: 200 })) as typeof fetch;
    const restarted = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      outboxDir: outbox,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    restarted.start();
    try {
      await vi.waitFor(() => expect(outboxFiles(outbox)).toHaveLength(0), { timeout: 1000 });
    } finally {
      restarted.stop();
    }
  });

  it("retries backlog on the periodic tick after startup delivery fails", async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    writeFileSync(join(root, "periodic.md"), "periodic replay\n");
    const seed = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      outboxDir: outbox,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await seed.flush(root, "periodic.md");

    let tick: (() => void) | undefined;
    const intervalHandle = setInterval(() => {}, 60_000);
    const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((handler, delay) => {
      expect(delay).toBe(15_000);
      tick = handler as () => void;
      return intervalHandle;
    }) as typeof setInterval);
    const w = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      outboxDir: outbox,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    w.start();
    try {
      await wait(50);
      expect(outboxFiles(outbox)).toHaveLength(1);
      (globalThis as { fetch: typeof fetch }).fetch = (async () =>
        new Response("{}", { status: 200 })) as typeof fetch;
      expect(tick).toBeTypeOf("function");
      tick?.();
      await vi.waitFor(() => expect(outboxFiles(outbox)).toHaveLength(0), { timeout: 1000 });
    } finally {
      w.stop();
      clearInterval(intervalHandle);
      intervalSpy.mockRestore();
    }
  });

  it("serializes concurrent delivery and replay without duplicate transmission", async () => {
    writeFileSync(join(root, "one.md"), "one\n");
    writeFileSync(join(root, "two.md"), "two\n");
    const w = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      outboxDir: outbox,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await Promise.all([
      w.flush(root, "one.md"),
      w.replay(),
      w.flush(root, "two.md"),
      w.replay(),
    ]);

    const observations = captured.map((entry) => entry.body as { captureId: string });
    expect(observations).toHaveLength(2);
    expect(new Set(observations.map((body) => body.captureId)).size).toBe(2);
    expect(outboxFiles(outbox)).toHaveLength(0);
  });

  it("preserves malformed envelopes while replaying valid ones", async () => {
    writeFileSync(join(outbox, "malformed.json"), "{not-json");
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    writeFileSync(join(root, "valid.md"), "valid\n");
    const w = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      outboxDir: outbox,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await w.flush(root, "valid.md");
    expect(outboxFiles(outbox)).toHaveLength(2);

    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response("{}", { status: 200 })) as typeof fetch;
    await w.replay();

    expect(outboxFiles(outbox).map((file) => file.split(/[\\/]/).pop())).toEqual(["malformed.json"]);
    expect(readFileSync(join(outbox, "malformed.json"), "utf8")).toBe("{not-json");
  });

  it("assigns distinct capture IDs to write and delete events for the same path", async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    const target = join(root, "lifecycle.md");
    writeFileSync(target, "present\n");
    const w = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      outboxDir: outbox,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await w.flush(root, "lifecycle.md");
    unlinkSync(target);
    await w.flush(root, "lifecycle.md");

    const bodies = outboxBodies(outbox) as Array<{
      captureId: string;
      data: { changeKind: string };
    }>;
    expect(bodies).toHaveLength(2);
    expect(new Set(bodies.map((body) => body.captureId)).size).toBe(2);
    expect(bodies.map((body) => body.data.changeKind).sort()).toEqual([
      "file_change",
      "file_delete",
    ]);
  });

  it("debounces rapid writes to a single observation", async () => {
    const w = new FilesystemWatcher({
      roots: [root],
      baseUrl: "http://localhost:3111",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    w.start();
    try {
      const target = join(root, "burst.md");
      writeFileSync(target, "1\n");
      writeFileSync(target, "2\n");
      writeFileSync(target, "3\n");
      writeFileSync(target, "4\n");
      await wait(900);
      const hits = captured.filter((c) =>
        (c.body as { data: { files: string[] } }).data?.files?.[0] === "burst.md",
      );
      expect(hits.length).toBeLessThanOrEqual(2);
    } finally {
      w.stop();
    }
  });
});

describe("configFromEnv", () => {
  it("parses comma-separated dirs and ignore patterns", () => {
    const cfg = configFromEnv({
      AGENTMEMORY_FS_WATCH_DIRS: " /a , /b ",
      AGENTMEMORY_FS_WATCH_IGNORE: "foo$, ^bar",
      AGENTMEMORY_URL: "http://localhost:3111",
      AGENTMEMORY_SECRET: "tok",
      AGENTMEMORY_PROJECT: "demo",
      AGENTMEMORY_OUTBOX_DIR: "/tmp/agentmemory-outbox",
    });
    expect(cfg.roots).toEqual(["/a", "/b"]);
    expect(cfg.baseUrl).toBe("http://localhost:3111");
    expect(cfg.secret).toBe("tok");
    expect(cfg.project).toBe("demo");
    expect(cfg.outboxDir).toBe("/tmp/agentmemory-outbox");
    expect(cfg.ignorePatterns).toHaveLength(2);
    expect(cfg.ignorePatterns[0].test("abcfoo")).toBe(true);
    expect(cfg.ignorePatterns[1].test("barbaz")).toBe(true);
  });

  it("returns empty roots when the env var is missing", () => {
    const cfg = configFromEnv({});
    expect(cfg.roots).toEqual([]);
  });
});
