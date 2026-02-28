import { CAPABILITY_HOOKS } from "./capability-manager.js";
import { KERNEL_VERSION } from "@copilot-hub/core/kernel-version";

export const EXTENSION_CONTRACT_VERSION = "1.0.0";

export function getExtensionContract() {
  return {
    contractVersion: EXTENSION_CONTRACT_VERSION,
    kernelVersion: KERNEL_VERSION,
    capability: {
      supportedHooks: [...CAPABILITY_HOOKS],
      registryEntry: {
        required: ["id", "manifestPath"],
        optional: ["enabled", "options"]
      },
      manifest: {
        required: ["id", "entry"],
        optional: ["name", "version", "hooks", "permissions", "minKernelVersion", "timeoutMs"]
      },
      scaffold: {
        manifestPathPattern: "capabilities/<capabilityId>/manifest.json",
        entryPathPattern: "capabilities/<capabilityId>/index.js",
        defaultHooks: ["onTurnStart"],
        defaultTimeoutMs: 5000
      }
    }
  };
}
