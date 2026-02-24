export class WhatsAppChannel {
  constructor({ channelConfig, runtime }) {
    this.kind = "whatsapp";
    this.id = String(channelConfig.id ?? "whatsapp");
    this.config = channelConfig;
    this.runtime = runtime;
    this.running = false;
    this.error = null;
  }

  async start() {
    this.running = false;
    this.error =
      "WhatsApp adapter is declared but not wired yet. Provide implementation in src/channels/whatsapp-channel.js.";
    return this.getStatus();
  }

  async stop() {
    this.running = false;
    return this.getStatus();
  }

  async shutdown() {
    await this.stop();
  }

  async notifyApproval() {
    return;
  }

  getStatus() {
    return {
      kind: this.kind,
      id: this.id,
      running: this.running,
      error: this.error
    };
  }
}
