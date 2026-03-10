import process from "node:process";
import { spawnSync } from "node:child_process";

type StdioMode = "pipe" | "inherit" | ["ignore", "pipe", "pipe"];

type CodexSpawnSpec = {
  command: string;
  args: string[];
  shell: boolean;
};

export function requiresNodeScriptCodexBin(command: string): boolean {
  return /\.(cjs|mjs|js)$/i.test(String(command ?? "").trim());
}

export function requiresShellWrappedCodexBin(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(String(command ?? "").trim());
}

export function buildCodexSpawnSpec({
  codexBin,
  args,
  platform = process.platform,
  nodeBin = process.execPath,
}: {
  codexBin: string;
  args: string[];
  platform?: NodeJS.Platform;
  nodeBin?: string;
}): CodexSpawnSpec {
  if (requiresNodeScriptCodexBin(codexBin)) {
    return {
      command: nodeBin,
      args: [codexBin, ...args],
      shell: false,
    };
  }

  if (requiresShellWrappedCodexBin(codexBin, platform)) {
    return {
      command: [quoteWindowsShellValue(codexBin), ...args.map(quoteWindowsShellValue)].join(" "),
      args: [],
      shell: true,
    };
  }

  return {
    command: codexBin,
    args: [...args],
    shell: false,
  };
}

export function spawnCodexSync({
  codexBin,
  args,
  cwd,
  stdio,
  encoding = "utf8",
  input,
}: {
  codexBin: string;
  args: string[];
  cwd: string;
  stdio: StdioMode;
  encoding?: BufferEncoding;
  input?: string;
}) {
  const spec = buildCodexSpawnSpec({ codexBin, args });
  return spawnSync(spec.command, spec.args, {
    cwd,
    stdio,
    shell: spec.shell,
    encoding,
    ...(input !== undefined ? { input } : {}),
  });
}

function quoteWindowsShellValue(value: string): string {
  return `"${String(value ?? "").replace(/"/g, '\\"')}"`;
}
