const DEFAULT_HUB_TELEGRAM_TOKEN_ENV = "HUB_TELEGRAM_TOKEN_FILE";
const LEGACY_HUB_TELEGRAM_TOKEN_ENV = "HUB_TELEGRAM_TOKEN";
const TELEGRAM_TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;

export type HubTokenResolution = {
  tokenEnvName: string;
  token: string;
  source: "env_file" | "process_env";
  warnings: string[];
};

export function resolveHubTelegramToken({
  env = process.env,
  envFileValues = {},
}: {
  env?: NodeJS.ProcessEnv;
  envFileValues?: Record<string, string>;
} = {}): HubTokenResolution {
  const fileTokenEnvName = String(envFileValues.HUB_TELEGRAM_TOKEN_ENV ?? "").trim();
  const processTokenEnvName = String(env.HUB_TELEGRAM_TOKEN_ENV ?? "").trim();
  const tokenEnvName = fileTokenEnvName || processTokenEnvName || DEFAULT_HUB_TELEGRAM_TOKEN_ENV;
  const fileToken = String(envFileValues[tokenEnvName] ?? "").trim();
  const processToken = String(env[tokenEnvName] ?? "").trim();
  const token = fileToken || processToken;
  const warnings: string[] = [];

  if (fileTokenEnvName && processTokenEnvName && fileTokenEnvName !== processTokenEnvName) {
    warnings.push(
      `Config file selects hub token variable '${fileTokenEnvName}', overriding pre-existing process env selector '${processTokenEnvName}'.`,
    );
  }

  if (tokenEnvName === LEGACY_HUB_TELEGRAM_TOKEN_ENV) {
    warnings.push(
      `Hub token variable '${LEGACY_HUB_TELEGRAM_TOKEN_ENV}' is deprecated. Run 'copilot-hub configure' to migrate to '${DEFAULT_HUB_TELEGRAM_TOKEN_ENV}'.`,
    );
  }

  if (fileToken && processToken && fileToken !== processToken) {
    const detail = isUsableTelegramToken(fileToken)
      ? `Using the token saved in the config file for '${tokenEnvName}' instead of the conflicting process environment value.`
      : `Config file value for '${tokenEnvName}' overrides the conflicting process environment value.`;
    warnings.push(detail);
  }

  return {
    tokenEnvName,
    token,
    source: fileToken ? "env_file" : "process_env",
    warnings,
  };
}

export function isUsableTelegramToken(value: unknown): boolean {
  const token = String(value ?? "").trim();
  if (!token || token.toLowerCase().includes("replace_me")) {
    return false;
  }
  return TELEGRAM_TOKEN_PATTERN.test(token);
}
