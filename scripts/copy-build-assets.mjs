import { copyFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function copyBuildAssets(rootPath = process.cwd()) {
  const distPath = join(rootPath, "dist");
  const viewerPath = join(distPath, "viewer");
  await mkdir(viewerPath, { recursive: true });

  await Promise.all([
    copyFile(join(rootPath, "iii-config.yaml"), join(distPath, "iii-config.yaml")),
    copyFile(
      join(rootPath, "iii-config.docker.yaml"),
      join(distPath, "iii-config.docker.yaml"),
    ),
    copyFile(
      join(rootPath, "docker-compose.yml"),
      join(distPath, "docker-compose.yml"),
    ),
    copyFile(join(rootPath, ".env.example"), join(distPath, ".env.example")),
    copyFile(
      join(rootPath, "src", "viewer", "index.html"),
      join(viewerPath, "index.html"),
    ),
    copyFile(
      join(rootPath, "src", "viewer", "favicon.svg"),
      join(viewerPath, "favicon.svg"),
    ),
  ]);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await copyBuildAssets();
}
