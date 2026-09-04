export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoteChar = value[0] === '"' || value[0] === "'" ? value[0] : "";
    if (quoteChar) {
      const closeIdx = value.indexOf(quoteChar, 1);
      if (closeIdx !== -1) value = value.slice(1, closeIdx);
    } else {
      const hashIdx = value.indexOf(" #");
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    }
    out[key] = value;
  }
  return out;
}
