import fs from "node:fs";
import path from "node:path";

export const WINDOWS_HIDDEN_LAUNCHER_RESTART_DELAY_MS = 5_000;

export function resolveWindowsScriptHost(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = String(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows").trim();
  const baseDir = systemRoot || "C:\\Windows";
  return path.win32.join(baseDir, "System32", "wscript.exe");
}

export function getWindowsHiddenLauncherScriptPath(runtimeDir: string): string {
  return path.win32.join(runtimeDir, "windows-daemon-launcher.vbs");
}

export function getWindowsHiddenLauncherStopSignalPath(runtimeDir: string): string {
  return path.win32.join(runtimeDir, "windows-daemon-launcher.stop");
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
  const command = buildWindowsCommandLine([nodeBin, daemonScriptPath, "run"]);
  const stopSignalPath = getWindowsHiddenLauncherStopSignalPath(runtimeDir);
  return [
    "Option Explicit",
    "Dim shell, fso, command, stopSignalPath, restartDelayMs",
    'Set shell = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `shell.CurrentDirectory = "${escapeVbsString(runtimeDir)}"`,
    `command = "${escapeVbsString(command)}"`,
    `stopSignalPath = "${escapeVbsString(stopSignalPath)}"`,
    `restartDelayMs = ${String(WINDOWS_HIDDEN_LAUNCHER_RESTART_DELAY_MS)}`,
    "Do",
    "  If fso.FileExists(stopSignalPath) Then",
    "    On Error Resume Next",
    "    fso.DeleteFile stopSignalPath, True",
    "    On Error GoTo 0",
    "    Exit Do",
    "  End If",
    "  shell.Run command, 0, True",
    "  If fso.FileExists(stopSignalPath) Then",
    "    On Error Resume Next",
    "    fso.DeleteFile stopSignalPath, True",
    "    On Error GoTo 0",
    "    Exit Do",
    "  End If",
    "  WScript.Sleep restartDelayMs",
    "Loop",
    "Set fso = Nothing",
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
