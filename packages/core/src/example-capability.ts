export function createExampleCapability({ runtimeId }: { runtimeId: string }) {
  return {
    async onRuntimeStart() {
      console.log(`[${runtimeId}] example-capability loaded.`);
    },

    async onTurnStart({ metadata }: { metadata?: Record<string, unknown> }) {
      return {
        metadata: {
          ...(metadata ?? {}),
          capabilityTag: "example-capability",
        },
      };
    },

    async onTurnResult({ result }: { result?: { assistantText?: string } }) {
      if (!result?.assistantText) {
        return;
      }
      console.log(
        `[${runtimeId}] example-capability observed output length=${result.assistantText.length}.`,
      );
    },
  };
}
