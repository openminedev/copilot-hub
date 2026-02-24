export const CONTROL_ACTIONS = Object.freeze({
  BOTS_LIST: "bots:list",
  BOTS_STATUS: "bots:status",
  BOTS_START: "bots:start",
  BOTS_STOP: "bots:stop",
  BOTS_CREATE: "bots:create",
  BOTS_DELETE: "bots:delete",
  BOTS_SET_POLICY: "bots:set_policy",
  BOTS_SET_PROJECT: "bots:set_project",
  BOTS_CAPABILITIES_LIST: "bots:capabilities:list",
  BOTS_CAPABILITIES_RELOAD: "bots:capabilities:reload",
  BOTS_CAPABILITIES_SCAFFOLD: "bots:capabilities:scaffold",
  PROJECTS_LIST: "projects:list",
  PROJECTS_CREATE: "projects:create",
  SECRETS_LIST: "secrets:list",
  SECRETS_SET: "secrets:set",
  SECRETS_DELETE: "secrets:delete",
  EXTENSIONS_CONTRACT_GET: "extensions:contract:get"
});

const CONTROL_ACTION_SET = new Set(Object.values(CONTROL_ACTIONS));

export function normalizeControlAction(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function isControlAction(value) {
  return CONTROL_ACTION_SET.has(normalizeControlAction(value));
}

export function requireControlAction(value) {
  const action = normalizeControlAction(value);
  if (!CONTROL_ACTION_SET.has(action)) {
    throw new Error(`Unsupported control action '${action || "<empty>"}'.`);
  }
  return action;
}

export const CONTROL_ACTION_LIST = Object.freeze([...CONTROL_ACTION_SET]);
