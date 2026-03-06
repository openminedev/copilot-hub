type ChannelConfig = {
  id?: unknown;
} & Record<string, unknown>;

type ChannelStatus = {
  kind: "whatsapp";
  id: string;
  running: boolean;
  error: string | null;
};

export class WhatsAppChannel {
  kind: "whatsapp";
  id: string;
  config: ChannelConfig;
  runtime: unknown;
  running: boolean;
  error: string | null;

  constructor({ channelConfig, runtime }: { channelConfig: ChannelConfig; runtime: unknown }) {
    this.kind = "whatsapp";
    this.id = String(channelConfig.id ?? "whatsapp");
    this.config = channelConfig;
    this.runtime = runtime;
    this.running = false;
    this.error = null;
  }

  async start(): Promise<ChannelStatus> {
    this.running = false;
    this.error =
      "WhatsApp adapter is declared but not wired yet. Provide implementation in src/channels/whatsapp-channel.js.";
    return this.getStatus();
  }

  async stop(): Promise<ChannelStatus> {
    this.running = false;
    return this.getStatus();
  }

  async shutdown(): Promise<void> {
    await this.stop();
  }

  async notifyApproval(): Promise<void> {
    return;
  }

  getStatus(): ChannelStatus {
    return {
      kind: this.kind,
      id: this.id,
      running: this.running,
      error: this.error,
    };
  }
}
