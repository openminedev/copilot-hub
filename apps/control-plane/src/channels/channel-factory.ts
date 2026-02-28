// @ts-nocheck
import { TelegramChannel } from "./telegram-channel.js";
import { WhatsAppChannel } from "./whatsapp-channel.js";

export function createChannelAdapter({ channelConfig, runtime }) {
  const kind = String(channelConfig?.kind ?? "")
    .trim()
    .toLowerCase();

  if (kind === "telegram") {
    return new TelegramChannel({
      channelConfig,
      runtime,
    });
  }

  if (kind === "whatsapp") {
    return new WhatsAppChannel({
      channelConfig,
      runtime,
    });
  }

  throw new Error(`Unsupported channel kind '${kind}'.`);
}
