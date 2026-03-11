import fs from "node:fs";

export function ensureEnvTextFile(filePath: string): void {
  if (fs.existsSync(filePath)) {
    return;
  }
  fs.mkdirSync(requireParentDir(filePath), { recursive: true });
  fs.writeFileSync(filePath, "", "utf8");
}

export function readEnvLines(filePath: string): string[] {
  const content = fs.readFileSync(filePath, "utf8");
  return content.split(/\r?\n/);
}

export function writeEnvLines(filePath: string, lines: string[]): void {
  const normalized = [...lines];
  if (normalized.length === 0 || normalized[normalized.length - 1] !== "") {
    normalized.push("");
  }
  fs.writeFileSync(filePath, normalized.join("\n"), "utf8");
}

export function parseEnvMap(lines: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) {
      continue;
    }

    const key = match[1];
    const value = unquote(match[2] ?? "");
    map[key] = value;
  }
  return map;
}

export function setEnvValue(lines: string[], key: string, value: unknown): void {
  const safeValue = sanitizeEnvValue(value);
  const pattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  for (let index = 0; index < lines.length; index += 1) {
    if (!pattern.test(lines[index])) {
      continue;
    }

    lines[index] = `${key}=${safeValue}`;
    return;
  }

  if (lines.length > 0 && lines[lines.length - 1] !== "") {
    lines.push("");
  }
  lines.push(`${key}=${safeValue}`);
}

export function removeEnvKeys(lines: string[], keys: readonly string[]): boolean {
  const patterns = keys.map((key) => new RegExp(`^\\s*${escapeRegex(key)}\\s*=`));
  const originalLength = lines.length;
  const kept = lines.filter((line) => !patterns.some((pattern) => pattern.test(line)));
  if (kept.length === originalLength) {
    return false;
  }
  lines.splice(0, lines.length, ...kept);
  return true;
}

export function sanitizeEnvValue(value: unknown): string {
  return String(value ?? "")
    .replace(/[\r\n]/g, "")
    .trim();
}

function unquote(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }

  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }

  return raw;
}

function escapeRegex(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requireParentDir(filePath: string): string {
  const parts = String(filePath ?? "").split(/[\\/]/);
  if (parts.length <= 1) {
    return ".";
  }
  parts.pop();
  return parts.join("/") || ".";
}
