import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { spawnCodexSync } from "./codex-spawn.mjs";
import {
  compareSemver,
  codexVersionRequirementLabel,
  extractSemver,
  isCodexVersionCompatible,
} from "./codex-version.mjs";

type ResolvedCodexBin = {
  bin: string;
  source: string;
  userConfigured: boolean;
};

type ProbeCodexVersionResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  errorMessage: string;
  errorCode: string;
  version: string;
  rawVersion: string;
  compatible: boolean;
};

export function resolveCodexBinForStart({
  repoRoot,
  agentEngineEnvPath,
  controlPlaneEnvPath,
  env = process.env,
}: {
  repoRoot: string;
  agentEngineEnvPath: string;
  controlPlaneEnvPath: string;
  env?: NodeJS.ProcessEnv;
}): ResolvedCodexBin {
  const fromEnv = nonEmpty(env.CODEX_BIN);
  if (fromEnv) {
    return buildResolvedCodexBin({
      value: fromEnv,
      source: "process_env",
      env,
      repoRoot,
    });
  }

  for (const [source, envPath] of [
    ["agent_env", agentEngineEnvPath],
    ["control_plane_env", controlPlaneEnvPath],
  ] as const) {
    const value = readEnvValue(envPath, "CODEX_BIN");
    if (value) {
      return buildResolvedCodexBin({
        value,
        source,
        env,
        repoRoot,
      });
    }
  }

  const detected = findDetectedCodexBin(env, repoRoot);
  if (detected) {
    return {
      bin: detected,
      source: "detected",
      userConfigured: false,
    };
  }

  return {
    bin: "codex",
    source: "default",
    userConfigured: false,
  };
}

export function resolveCompatibleInstalledCodexBin({
  repoRoot,
  env = process.env,
}: {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const matches: Array<{ candidate: string; version: string; priority: number }> = [];

  for (const candidate of listCodexBinCandidates(env, repoRoot)) {
    const probe = probeCodexVersion({
      codexBin: candidate,
      repoRoot,
    });
    if (!probe.ok || !probe.compatible) {
      continue;
    }

    matches.push({
      candidate,
      version: probe.version,
      priority: getCodexCandidatePriority(candidate, env, repoRoot),
    });
  }

  if (matches.length === 0) {
    return "";
  }

  matches.sort((left, right) => {
    const versionOrder = compareSemver(right.version, left.version);
    if (versionOrder !== 0) {
      return versionOrder;
    }
    return left.priority - right.priority;
  });

  return matches[0]?.candidate ?? "";
}

export function probeCodexVersion({
  codexBin,
  repoRoot,
}: {
  codexBin: string;
  repoRoot: string;
}): ProbeCodexVersionResult {
  const status = runCodex({
    codexBin,
    args: ["--version"],
    repoRoot,
  });
  if (!status.ok) {
    return {
      ...status,
      version: "",
      rawVersion: "",
      compatible: false,
    };
  }

  const rawVersion = firstLine(status.stdout) || firstLine(status.stderr);
  const version = extractSemver(rawVersion);
  if (!version) {
    return {
      ok: false,
      stdout: status.stdout,
      stderr: status.stderr,
      errorMessage: `Could not parse Codex version from '${rawVersion || "empty output"}'.`,
      errorCode: "INVALID_VERSION",
      version: "",
      rawVersion,
      compatible: false,
    };
  }

  return {
    ...status,
    version,
    rawVersion,
    compatible: isCodexVersionCompatible(version),
  };
}

export function buildCodexCompatibilitySummary({
  resolved,
  probe,
}: {
  resolved: ResolvedCodexBin;
  probe: ProbeCodexVersionResult;
}): string {
  if (probe.ok) {
    return `Codex binary '${resolved.bin}' is version ${probe.version}.`;
  }

  if (probe.errorCode === "ENOENT") {
    return `Codex binary '${resolved.bin}' was not found.`;
  }

  return probe.errorMessage || `Codex binary '${resolved.bin}' is not usable.`;
}

export function buildCodexCompatibilityNotice({
  resolved,
  probe,
}: {
  resolved: ResolvedCodexBin;
  probe: ProbeCodexVersionResult;
}): string {
  return [
    buildCodexCompatibilitySummary({ resolved, probe }),
    `copilot-hub requires Codex CLI ${codexVersionRequirementLabel}.`,
  ].join("\n");
}

export function buildCodexCompatibilityError({
  resolved,
  probe,
  includeInstallHint,
  installCommand,
}: {
  resolved: ResolvedCodexBin;
  probe: ProbeCodexVersionResult;
  includeInstallHint: boolean;
  installCommand: string;
}): string {
  const lines = [
    buildCodexCompatibilitySummary({ resolved, probe }),
    `copilot-hub requires Codex CLI ${codexVersionRequirementLabel}.`,
  ];

  if (includeInstallHint) {
    lines.push(`Install a compatible version with '${installCommand}', then retry.`);
  } else {
    lines.push("Update that binary or point CODEX_BIN to a compatible executable, then retry.");
  }

  return lines.join("\n");
}

function buildResolvedCodexBin({
  value,
  source,
  env,
  repoRoot,
}: {
  value: string;
  source: string;
  env: NodeJS.ProcessEnv;
  repoRoot: string;
}): ResolvedCodexBin {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized && normalized !== "codex") {
    return {
      bin: value,
      source,
      userConfigured: true,
    };
  }

  const detected = findDetectedCodexBin(env, repoRoot);
  return {
    bin: detected || "codex",
    source,
    userConfigured: false,
  };
}

function findDetectedCodexBin(env: NodeJS.ProcessEnv, repoRoot: string): string {
  if (process.platform !== "win32") {
    return "";
  }

  return findWindowsNpmGlobalCodexBin(env, repoRoot) || findVscodeCodexExe(env) || "";
}

function listCodexBinCandidates(env: NodeJS.ProcessEnv, repoRoot: string): string[] {
  return dedupe(["codex", findWindowsNpmGlobalCodexBin(env, repoRoot), findVscodeCodexExe(env)]);
}

function getCodexCandidatePriority(
  candidate: string,
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): number {
  if (candidate === "codex") {
    return 0;
  }

  const npmGlobal = findWindowsNpmGlobalCodexBin(env, repoRoot);
  if (npmGlobal && candidate === npmGlobal) {
    return 1;
  }

  const vscode = findVscodeCodexExe(env);
  if (vscode && candidate === vscode) {
    return 2;
  }

  return 3;
}

function findVscodeCodexExe(env: NodeJS.ProcessEnv): string {
  const userProfile = nonEmpty(env.USERPROFILE);
  if (!userProfile) {
    return "";
  }

  const extensionsDir = path.join(userProfile, ".vscode", "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return "";
  }

  const candidates = fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("openai.chatgpt-"))
    .sort()
    .reverse();

  for (const folder of candidates) {
    const exePath = path.join(extensionsDir, folder, "bin", "windows-x86_64", "codex.exe");
    if (fs.existsSync(exePath)) {
      return exePath;
    }
  }

  return "";
}

function findWindowsNpmGlobalCodexBin(env: NodeJS.ProcessEnv, repoRoot: string): string {
  if (process.platform !== "win32") {
    return "";
  }

  const packageRoots: string[] = [];
  const candidates: string[] = [];
  const appData = nonEmpty(env.APPDATA);
  if (appData) {
    packageRoots.push(path.join(appData, "npm", "node_modules", "@openai", "codex"));
    candidates.push(path.join(appData, "npm", "codex.cmd"));
    candidates.push(path.join(appData, "npm", "codex.exe"));
    candidates.push(path.join(appData, "npm", "codex"));
  }

  const npmPrefix = readNpmPrefix(repoRoot);
  if (npmPrefix) {
    packageRoots.push(path.join(npmPrefix, "node_modules", "@openai", "codex"));
    candidates.push(path.join(npmPrefix, "codex.cmd"));
    candidates.push(path.join(npmPrefix, "codex.exe"));
    candidates.push(path.join(npmPrefix, "codex"));
  }

  for (const packageRoot of dedupe(packageRoots)) {
    const entrypoint = path.join(packageRoot, "bin", "codex.js");
    if (fs.existsSync(entrypoint)) {
      return entrypoint;
    }
  }

  for (const candidate of dedupe(candidates)) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return "";
}

function readNpmPrefix(repoRoot: string): string {
  const result = spawnNpm(["config", "get", "prefix"], repoRoot);
  if (result.error || result.status !== 0) {
    return "";
  }

  const value = String(result.stdout ?? "").trim();
  if (!value || value.toLowerCase() === "undefined") {
    return "";
  }
  return value;
}

function runCodex({
  codexBin,
  args,
  repoRoot,
}: {
  codexBin: string;
  args: string[];
  repoRoot: string;
}) {
  const result = spawnCodex(codexBin, args, repoRoot);

  if (result.error) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      errorMessage: formatCodexSpawnError(codexBin, result.error),
      errorCode: normalizeErrorCode(result.error),
    };
  }

  const code = Number.isInteger(result.status) ? result.status : 1;
  return {
    ok: code === 0,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
    errorMessage: "",
    errorCode: "",
  };
}

function spawnCodex(codexBin: string, args: string[], repoRoot: string) {
  return spawnCodexSync({
    codexBin,
    args,
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function readEnvValue(filePath: string, key: string): string {
  if (!fs.existsSync(filePath)) {
    return "";
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const pattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*(.*)\\s*$`);
  for (const line of lines) {
    const match = line.match(pattern);
    if (!match) {
      continue;
    }
    return unquote(match[1]);
  }
  return "";
}

function unquote(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

function escapeRegex(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nonEmpty(value: unknown): string {
  const normalized = String(value ?? "").trim();
  return normalized || "";
}

function firstLine(value: unknown): string {
  return (
    String(value ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function formatCodexSpawnError(command: string, error: NodeJS.ErrnoException): string {
  const code = normalizeErrorCode(error);
  if (code === "ENOENT") {
    return `Codex binary '${command}' was not found. Install Codex CLI or set CODEX_BIN.`;
  }
  if (code === "EPERM") {
    return `Codex binary '${command}' cannot be executed (EPERM). Check permissions or CODEX_BIN.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Failed to execute '${command}': ${firstLine(message)}`;
}

function normalizeErrorCode(error: unknown): string {
  return String((error as { code?: unknown } | null | undefined)?.code ?? "")
    .trim()
    .toUpperCase();
}

function dedupe(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function spawnNpm(args: string[], repoRoot: string) {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    const commandLine = ["npm", ...args].join(" ");
    return spawnSync(comspec, ["/d", "/s", "/c", commandLine], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      encoding: "utf8",
    });
  }

  return spawnSync("npm", args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    encoding: "utf8",
  });
}
