import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("portable build assets", () => {
  it("uses the Node asset copier instead of POSIX-only shell commands", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
      scripts: { build: string };
    };

    expect(pkg.scripts.build).toContain("node scripts/copy-build-assets.mjs");
    expect(pkg.scripts.build).not.toMatch(/\bcp\s|mkdir -p|2>\/dev\/null|\|\| true/);
  });

  it("copies every required runtime asset into dist", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmemory-build-assets-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "src", "viewer"), { recursive: true });

    const assets = new Map([
      ["iii-config.yaml", "iii"],
      ["iii-config.docker.yaml", "docker"],
      ["docker-compose.yml", "compose"],
      [".env.example", "env"],
      [join("src", "viewer", "index.html"), "html"],
      [join("src", "viewer", "favicon.svg"), "svg"],
    ]);
    for (const [relativePath, contents] of assets) {
      writeFileSync(join(root, relativePath), contents, "utf-8");
    }

    const { copyBuildAssets } = (await import(
      "../scripts/copy-build-assets.mjs"
    )) as {
      copyBuildAssets: (rootPath: string) => Promise<void>;
    };
    await copyBuildAssets(root);

    expect(readFileSync(join(root, "dist", "iii-config.yaml"), "utf-8")).toBe(
      "iii",
    );
    expect(
      readFileSync(join(root, "dist", "iii-config.docker.yaml"), "utf-8"),
    ).toBe("docker");
    expect(readFileSync(join(root, "dist", "docker-compose.yml"), "utf-8")).toBe(
      "compose",
    );
    expect(readFileSync(join(root, "dist", ".env.example"), "utf-8")).toBe(
      "env",
    );
    expect(
      readFileSync(join(root, "dist", "viewer", "index.html"), "utf-8"),
    ).toBe("html");
    expect(
      readFileSync(join(root, "dist", "viewer", "favicon.svg"), "utf-8"),
    ).toBe("svg");
  });
});
