import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";

export type StableHookBundle = {
  root: string;
  files: string[];
  hashes: Record<string, string>;
};

type HookManifestLike = {
  hooks?: Record<string, Array<{
    hooks?: Array<{ command?: unknown }>;
  }>>;
};

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function referencedScripts(
  pluginRoot: string,
  manifestFiles: string[],
): Map<string, Buffer> {
  const scripts = new Map<string, Buffer>();
  for (const manifestFile of manifestFiles) {
    if (basename(manifestFile) !== manifestFile || extname(manifestFile) !== ".json") {
      throw new Error(`unsafe hook manifest path: ${manifestFile}`);
    }
    const manifestPath = join(pluginRoot, "hooks", manifestFile);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as HookManifestLike;
    for (const entries of Object.values(manifest.hooks ?? {})) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!Array.isArray(entry.hooks)) continue;
        for (const handler of entry.hooks) {
          if (typeof handler.command !== "string") continue;
          const pattern = /\$\{CLAUDE_PLUGIN_ROOT\}[\\/]scripts[\\/]([^"'\s]+)/g;
          for (const match of handler.command.matchAll(pattern)) {
            const relative = match[1]!;
            const name = basename(relative);
            if (relative !== name || extname(name) !== ".mjs") {
              throw new Error(`unsafe hook script path: ${relative}`);
            }
            const sourcePath = resolve(pluginRoot, "scripts", name);
            scripts.set(name, readFileSync(sourcePath));
          }
        }
      }
    }
  }
  return scripts;
}

export function installStableHookBundle(
  pluginRoot: string,
  targetRoot: string,
  manifestFiles: string[],
  options: { dryRun?: boolean } = {},
): StableHookBundle {
  const scripts = referencedScripts(pluginRoot, manifestFiles);
  const files = [...scripts.keys()].sort();
  const hashes = Object.fromEntries(
    files.map((name) => [name, sha256(scripts.get(name)!)]),
  );

  if (options.dryRun) {
    return { root: targetRoot, files, hashes };
  }

  mkdirSync(targetRoot, { recursive: true });
  for (const name of files) {
    const target = join(targetRoot, name);
    const temporary = `${target}.tmp-${process.pid}`;
    try {
      writeFileSync(temporary, scripts.get(name)!);
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    const targetHash = sha256(readFileSync(target));
    if (targetHash !== hashes[name]) {
      throw new Error(`stable hook hash mismatch: ${name}`);
    }
  }

  return { root: targetRoot, files, hashes };
}
