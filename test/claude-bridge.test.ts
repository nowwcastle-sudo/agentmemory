import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:path", async () => ({
  ...(await vi.importActual("node:path")),
  dirname: vi.fn().mockReturnValue("/tmp"),
}));

import { registerClaudeBridgeFunction } from "../src/functions/claude-bridge.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ClaudeBridgeConfig, Memory } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

const enabledConfig: ClaudeBridgeConfig = {
  enabled: true,
  projectPath: "/tmp/my-project",
  projectId: "project-current",
  legacyProjectIds: ["my-project"],
  memoryFilePath: "/tmp/.claude/MEMORY.md",
  lineBudget: 200,
};

const disabledConfig: ClaudeBridgeConfig = {
  enabled: false,
  projectPath: "",
  projectId: "",
  legacyProjectIds: [],
  memoryFilePath: "",
  lineBudget: 200,
};

describe("Claude Bridge Functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    vi.clearAllMocks();
  });

  it("claude-bridge-read returns content when file exists", async () => {
    registerClaudeBridgeFunction(sdk as never, kv as never, enabledConfig);

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      "# Memory\n\n## Project Summary\nA test project\n\n## Key Memories\nSome memories",
    );

    const result = (await sdk.trigger("mem::claude-bridge-read", {})) as {
      success: boolean;
      content: string;
      sections: Record<string, string>;
    };

    expect(result.success).toBe(true);
    expect(result.content).toContain("# Memory");
    expect(result.sections).toBeDefined();
    expect(result.sections["Project Summary"]).toBe("A test project");
  });

  it("claude-bridge-read returns empty when file does not exist", async () => {
    registerClaudeBridgeFunction(sdk as never, kv as never, enabledConfig);

    vi.mocked(existsSync).mockReturnValue(false);

    const result = (await sdk.trigger("mem::claude-bridge-read", {})) as {
      success: boolean;
      content: string;
      parsed: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.content).toBe("");
    expect(result.parsed).toBe(false);
  });

  it("claude-bridge-sync writes MEMORY.md with memories", async () => {
    registerClaudeBridgeFunction(sdk as never, kv as never, enabledConfig);

    const mem: Memory = {
      id: "mem_1",
      createdAt: "2026-02-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      type: "pattern",
      title: "Auth pattern",
      content: "Always validate tokens",
      concepts: ["auth"],
      files: [],
      sessionIds: ["ses_1"],
      strength: 5,
      version: 1,
      isLatest: true,
      project: "project-current",
    };
    await kv.set("mem:memories", "mem_1", mem);

    vi.mocked(existsSync).mockReturnValue(true);

    const result = (await sdk.trigger("mem::claude-bridge-sync", {})) as {
      success: boolean;
      path: string;
      lines: number;
    };

    expect(result.success).toBe(true);
    expect(result.path).toBe("/tmp/.claude/MEMORY.md");
    expect(writeFileSync).toHaveBeenCalled();
    const writtenContent = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    expect(writtenContent).toContain("Auth pattern");
  });

  it("exports only the canonical project and reads its profile summary", async () => {
    registerClaudeBridgeFunction(sdk as never, kv as never, enabledConfig);
    const memory = (
      id: string,
      title: string,
      project?: string,
    ): Memory => ({
      id,
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
      type: "pattern",
      title,
      content: `${title} content`,
      concepts: [],
      files: [],
      sessionIds: ["session-1"],
      strength: 5,
      version: 1,
      isLatest: true,
      ...(project ? { project } : {}),
    });
    await kv.set("mem:memories", "current", memory(
      "current",
      "CURRENT-PROJECT-MARKER",
      "project-current",
    ));
    await kv.set("mem:memories", "foreign", memory(
      "foreign",
      "FOREIGN-PROJECT-MARKER",
      "project-foreign",
    ));
    await kv.set("mem:memories", "unscoped", memory(
      "unscoped",
      "UNSCOPED-MARKER",
    ));
    await kv.set("mem:profiles", "project-current", {
      summary: "CURRENT-PROFILE-SUMMARY",
    });
    vi.mocked(existsSync).mockReturnValue(true);

    const result = (await sdk.trigger("mem::claude-bridge-sync", {})) as {
      success: boolean;
    };
    const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;

    expect(result.success).toBe(true);
    expect(written).toContain("CURRENT-PROJECT-MARKER");
    expect(written).toContain("CURRENT-PROFILE-SUMMARY");
    expect(written).not.toContain("FOREIGN-PROJECT-MARKER");
    expect(written).not.toContain("UNSCOPED-MARKER");
  });

  it("accepts raw-path and legacy project IDs during migration", async () => {
    registerClaudeBridgeFunction(sdk as never, kv as never, enabledConfig);
    const rawPathMemory: Memory = {
      id: "raw-path",
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
      type: "fact",
      title: "RAW-PATH-MARKER",
      content: "raw path compatibility",
      concepts: [],
      files: [],
      sessionIds: ["session-raw"],
      strength: 4,
      version: 1,
      isLatest: true,
      project: enabledConfig.projectPath,
    };
    const legacyMemory: Memory = {
      ...rawPathMemory,
      id: "legacy",
      title: "LEGACY-ID-MARKER",
      project: enabledConfig.legacyProjectIds[0],
    };
    await kv.set("mem:memories", rawPathMemory.id, rawPathMemory);
    await kv.set("mem:memories", legacyMemory.id, legacyMemory);
    await kv.set("mem:profiles", enabledConfig.projectPath, {
      summary: "RAW-PATH-PROFILE-SUMMARY",
    });
    vi.mocked(existsSync).mockReturnValue(true);

    await sdk.trigger("mem::claude-bridge-sync", {});
    const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;

    expect(written).toContain("RAW-PATH-MARKER");
    expect(written).toContain("LEGACY-ID-MARKER");
    expect(written).toContain("RAW-PATH-PROFILE-SUMMARY");
  });

  it("claude-bridge-sync returns error when not configured", async () => {
    registerClaudeBridgeFunction(sdk as never, kv as never, disabledConfig);

    const result = (await sdk.trigger("mem::claude-bridge-sync", {})) as {
      success: boolean;
      error: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain("not configured");
  });

  it("claude-bridge-read returns error when not configured", async () => {
    registerClaudeBridgeFunction(sdk as never, kv as never, disabledConfig);

    const result = (await sdk.trigger("mem::claude-bridge-read", {})) as {
      success: boolean;
      error: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain("not configured");
  });
});
