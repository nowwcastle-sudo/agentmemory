import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentMemoryOutboxPath,
  resolvePathLayout,
  runtimeMetadataPath,
} from "../src/runtime-paths.js";

describe("runtime metadata paths", () => {
  it("resolves every user-scope path from the injected home", () => {
    const home = "C:\\Users\\laptop user";
    const configRoot = join(home, ".agentmemory");

    expect(resolvePathLayout({ env: {}, home })).toEqual({
      configRoot,
      envFile: join(configRoot, ".env"),
      runtimeDir: configRoot,
      backupsDir: join(configRoot, "backups"),
      snapshotsDir: join(configRoot, "snapshots"),
      hooksDir: join(configRoot, "hooks", "current"),
    });
  });

  it("keeps documented runtime, snapshot, and outbox overrides independent", () => {
    const env = {
      AGENTMEMORY_RUNTIME_DIR: "D:\\runtime",
      SNAPSHOT_DIR: "D:\\snapshots",
      AGENTMEMORY_OUTBOX_DIR: "D:\\outbox",
    };
    const options = { env, home: "C:\\Users\\u" };

    expect(resolvePathLayout(options).runtimeDir).toBe(resolve("D:\\runtime"));
    expect(resolvePathLayout(options).snapshotsDir).toBe(resolve("D:\\snapshots"));
    expect(agentMemoryOutboxPath("codex", options)).toBe(resolve("D:\\outbox"));
  });

  it("does not create the injected home or any child directory", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "am-path-layout-"));
    const missingHome = join(sandbox, "new user");
    try {
      expect(existsSync(missingHome)).toBe(false);
      resolvePathLayout({ env: {}, home: missingHome });
      agentMemoryOutboxPath("codex", { env: {}, home: missingHome });
      runtimeMetadataPath("worker.pid", { env: {}, home: missingHome });
      expect(existsSync(missingHome)).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("uses an explicit runtime directory so instances do not share metadata", () => {
    expect(
      runtimeMetadataPath("engine-state.json", {
        env: { AGENTMEMORY_RUNTIME_DIR: "/var/lib/agentmemory/instance-2" },
        home: "/home/test",
      }),
    ).toBe(join(resolve("/var/lib/agentmemory/instance-2"), "engine-state.json"));
  });

  it("keeps instance-zero lifecycle state canonical across data-dir changes", () => {
    expect(
      runtimeMetadataPath("engine-state.json", {
        env: { AGENTMEMORY_DATA_DIR: "/var/lib/agentmemory/custom" },
        home: "/home/test",
      }),
    ).toBe(join("/home/test", ".agentmemory", "engine-state.json"));
  });

  it("keeps the legacy home fallback for direct worker launches", () => {
    expect(runtimeMetadataPath("worker.pid", { env: {}, home: "/home/test" })).toBe(
      join("/home/test", ".agentmemory", "worker.pid"),
    );
  });
});
