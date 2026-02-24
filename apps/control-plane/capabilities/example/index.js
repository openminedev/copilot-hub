export function createCapability({ runtimeId }) {
  return {
    async onRuntimeStart() {
      console.log(`[${runtimeId}] example-capability loaded.`);
    },

    async onTurnStart({ metadata }) {
      return {
        metadata: {
          ...metadata,
          capabilityTag: "example-capability"
        }
      };
    },

    async onTurnResult({ result }) {
      if (!result?.assistantText) {
        return;
      }
      console.log(`[${runtimeId}] example-capability observed output length=${result.assistantText.length}.`);
    }
  };
}
