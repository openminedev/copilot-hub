import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const PROCESS_START_TOLERANCE_MS = 120_000;

export type ManagedProcessState = {
  pid?: unknown;
  startedAt?: unknown;
  command?: unknown;
  executablePath?: unknown;
  entryScript?: unknown;
};

type ProcessIdentity = {
  pid: number;
  commandLine: string;
  executablePath: string | null;
  startedAt: string | null;
};

export function normalizePid(value: unknown): number {
  const pid = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return 0;
  }
  return pid;
}

export function isManagedProcessRunning(
  state: ManagedProcessState | null,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pid = normalizePid(state?.pid);
  if (pid <= 0) {
    return false;
  }
  if (!isProcessRunning(pid)) {
    return false;
  }

  const identity = inspectProcess(pid, platform);
  if (!identity) {
    return true;
  }

  return matchesManagedProcessState(state, identity, platform);
}

export function matchesManagedProcessState(
  state: ManagedProcessState | null,
  identity: ProcessIdentity | null,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pid = normalizePid(state?.pid);
  if (pid <= 0 || !identity) {
    return false;
  }
  if (normalizePid(identity.pid) !== pid) {
    return false;
  }

  const checks: boolean[] = [];
  const expectedScript = normalizeCommandToken(
    state?.entryScript ?? extractScriptToken(state?.command),
    platform,
  );
  if (expectedScript) {
    checks.push(commandLineContains(identity.commandLine, expectedScript, platform));
  }

  const expectedExecutablePath = normalizeCommandToken(
    state?.executablePath ?? extractExecutableToken(state?.command),
    platform,
  );
  if (expectedExecutablePath) {
    const actualExecutablePath = normalizeCommandToken(identity.executablePath, platform);
    if (actualExecutablePath) {
      checks.push(
        actualExecutablePath === expectedExecutablePath ||
          pathBasename(actualExecutablePath, platform) ===
            pathBasename(expectedExecutablePath, platform),
      );
    } else {
      checks.push(commandLineContains(identity.commandLine, expectedExecutablePath, platform));
    }
  }

  const expectedStartedAt = parseTimestamp(state?.startedAt);
  const actualStartedAt = parseTimestamp(identity.startedAt);
  if (expectedStartedAt !== null && actualStartedAt !== null) {
    checks.push(Math.abs(actualStartedAt - expectedStartedAt) <= PROCESS_START_TOLERANCE_MS);
  }

  if (checks.length === 0) {
    return true;
  }
  return checks.every(Boolean);
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function inspectProcess(pid: number, platform: NodeJS.Platform): ProcessIdentity | null {
  if (platform === "win32") {
    return inspectWindowsProcess(pid);
  }
  if (platform === "linux" || platform === "darwin") {
    return inspectPosixProcess(pid);
  }
  return null;
}

function inspectWindowsProcess(pid: number): ProcessIdentity | null {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
    "if ($null -eq $p) { exit 3 }",
    "$created = ''",
    "if ($p.CreationDate) {",
    "  try { $created = $p.CreationDate.ToString('o') } catch { $created = '' }",
    "}",
    "[pscustomobject]@{",
    "  pid = $p.ProcessId",
    "  commandLine = $p.CommandLine",
    "  executablePath = $p.ExecutablePath",
    "  startedAt = $created",
    "} | ConvertTo-Json -Compress",
  ].join("\n");

  for (const shell of resolveWindowsPowerShellCandidates()) {
    const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    });
    if (result.error || result.status !== 0) {
      continue;
    }
    const stdout = String(result.stdout ?? "").trim();
    if (!stdout) {
      continue;
    }
    try {
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      return {
        pid: normalizePid(parsed.pid),
        commandLine: String(parsed.commandLine ?? ""),
        executablePath: normalizeOptionalString(parsed.executablePath),
        startedAt: normalizeOptionalString(parsed.startedAt),
      };
    } catch {
      continue;
    }
  }

  return null;
}

function inspectPosixProcess(pid: number): ProcessIdentity | null {
  const commandResult = spawnSync("ps", ["-p", String(pid), "-o", "args="], {
    encoding: "utf8",
    shell: false,
  });
  if (commandResult.error || commandResult.status !== 0) {
    return null;
  }

  const commandLine = String(commandResult.stdout ?? "").trim();
  if (!commandLine) {
    return null;
  }

  const startedAtResult = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    shell: false,
  });
  const executablePathResult = spawnSync("ps", ["-p", String(pid), "-o", "comm="], {
    encoding: "utf8",
    shell: false,
  });

  return {
    pid,
    commandLine,
    executablePath: normalizeOptionalString(executablePathResult.stdout),
    startedAt: normalizeOptionalString(startedAtResult.stdout),
  };
}

function resolveWindowsPowerShellCandidates(): string[] {
  const candidates = [
    path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    "powershell.exe",
    "pwsh.exe",
  ];
  return [...new Set(candidates)];
}

function extractScriptToken(value: unknown): string | null {
  const tokens = tokenizeCommandLine(value);
  for (const token of tokens) {
    if (/\.(?:[cm]?js|mts)$/i.test(token)) {
      return token;
    }
  }
  return null;
}

function extractExecutableToken(value: unknown): string | null {
  const [first] = tokenizeCommandLine(value);
  return first ? normalizeOptionalString(first) : null;
}

function tokenizeCommandLine(value: unknown): string[] {
  const text = String(value ?? "").trim();
  if (!text) {
    return [];
  }

  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(text)) !== null) {
    const token = match[1] ?? match[2] ?? match[0] ?? "";
    const normalized = normalizeOptionalString(token);
    if (normalized) {
      tokens.push(normalized);
    }
  }
  return tokens;
}

function parseTimestamp(value: unknown): number | null {
  const text = normalizeOptionalString(value);
  if (!text) {
    return null;
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return timestamp;
}

function normalizeOptionalString(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
}

function normalizeCommandToken(value: unknown, platform: NodeJS.Platform): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }

  const unquoted = normalized.replace(/^["']+|["']+$/g, "");
  const slashed = platform === "win32" ? unquoted.replace(/\\/g, "/") : unquoted;
  return platform === "win32" ? slashed.toLowerCase() : slashed;
}

function commandLineContains(
  commandLine: string,
  expectedToken: string,
  platform: NodeJS.Platform,
): boolean {
  const normalizedCommandLine = normalizeCommandToken(commandLine, platform);
  if (!normalizedCommandLine) {
    return false;
  }
  return normalizedCommandLine.includes(expectedToken);
}

function pathBasename(value: string, platform: NodeJS.Platform): string {
  return (
    platform === "win32" ? path.win32.basename(value) : path.posix.basename(value)
  ).toLowerCase();
}
