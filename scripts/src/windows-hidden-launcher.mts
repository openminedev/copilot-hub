import fs from "node:fs";
import path from "node:path";

export function resolveWindowsScriptHost(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = String(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows").trim();
  const baseDir = systemRoot || "C:\\Windows";
  return path.win32.join(baseDir, "System32", "wscript.exe");
}

export function getWindowsHiddenLauncherScriptPath(runtimeDir: string): string {
  return path.win32.join(runtimeDir, "windows-daemon-launcher.vbs");
}

export function ensureWindowsHiddenLauncher({
  scriptPath,
  nodeBin,
  daemonScriptPath,
  runtimeDir,
}: {
  scriptPath: string;
  nodeBin: string;
  daemonScriptPath: string;
  runtimeDir: string;
}): string {
  const content = buildWindowsHiddenLauncherContent({
    nodeBin,
    daemonScriptPath,
    runtimeDir,
  });

  let current = "";
  try {
    current = fs.readFileSync(scriptPath, "utf8");
  } catch {
    current = "";
  }

  if (current !== content) {
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, content, "utf8");
  }

  return scriptPath;
}

export function buildWindowsHiddenLauncherCommand(
  scriptPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const scriptHost = resolveWindowsScriptHost(env);
  return `"${scriptHost}" //B //Nologo "${scriptPath}"`;
}

export function buildWindowsHiddenLauncherContent({
  nodeBin,
  daemonScriptPath,
  runtimeDir,
}: {
  nodeBin: string;
  daemonScriptPath: string;
  runtimeDir: string;
}): string {
  const command = buildWindowsCommandLine([nodeBin, daemonScriptPath, "start"]);
  return [
    "Option Explicit",
    "Dim shell",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = "${escapeVbsString(runtimeDir)}"`,
    `shell.Run "${escapeVbsString(command)}", 0, False`,
    "Set shell = Nothing",
    "",
  ].join("\r\n");
}

function buildWindowsCommandLine(args: string[]): string {
  return args.map((value) => `"${String(value ?? "")}"`).join(" ");
}

function escapeVbsString(value: string): string {
  return String(value ?? "").replace(/"/g, '""');
}
