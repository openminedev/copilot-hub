import assert from "node:assert/strict";
import test from "node:test";

let configPromise: Promise<any> | null = null;

async function loadConfig() {
  if (!configPromise) {
    const specifier = ["..", "hub-token-config.js"].join("/");
    configPromise = import(specifier);
  }
  return configPromise;
}

test("resolveHubTelegramToken prefers the config file token over a conflicting process env token", async () => {
  const { resolveHubTelegramToken } = await loadConfig();
  const result = resolveHubTelegramToken({
    env: {
      HUB_TELEGRAM_TOKEN_ENV: "HUB_TELEGRAM_TOKEN",
      HUB_TELEGRAM_TOKEN: "123456:invalid_process_value_ABCDEFGHIJKLM",
    },
    envFileValues: {
      HUB_TELEGRAM_TOKEN_ENV: "HUB_TELEGRAM_TOKEN",
      HUB_TELEGRAM_TOKEN: "123456:valid_file_value_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    },
  });

  assert.equal(result.tokenEnvName, "HUB_TELEGRAM_TOKEN");
  assert.equal(result.source, "env_file");
  assert.equal(result.token, "123456:valid_file_value_ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  assert.match(result.warnings.join("\n"), /deprecated/i);
});

test("resolveHubTelegramToken uses the dedicated file token variable by default", async () => {
  const { resolveHubTelegramToken } = await loadConfig();
  const result = resolveHubTelegramToken({
    env: {},
    envFileValues: {
      HUB_TELEGRAM_TOKEN_ENV: "HUB_TELEGRAM_TOKEN_FILE",
      HUB_TELEGRAM_TOKEN_FILE: "123456:valid_file_value_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    },
  });

  assert.equal(result.tokenEnvName, "HUB_TELEGRAM_TOKEN_FILE");
  assert.equal(result.source, "env_file");
  assert.equal(result.warnings.length, 0);
});

test("isUsableTelegramToken recognizes valid telegram token formats", async () => {
  const { isUsableTelegramToken } = await loadConfig();
  assert.equal(isUsableTelegramToken("123456:valid_file_value_ABCDEFGHIJKLMNOPQRSTUVWXYZ"), true);
  assert.equal(isUsableTelegramToken("123456:replace_me"), false);
  assert.equal(isUsableTelegramToken(""), false);
});
