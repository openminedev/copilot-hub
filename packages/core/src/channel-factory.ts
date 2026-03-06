import { TelegramChannel } from "./telegram-channel.js";
import { WhatsAppChannel } from "./whatsapp-channel.js";

type ChannelConfig = {
  kind?: unknown;
} & Record<string, unknown>;

type CreateChannelAdapterParams = {
  channelConfig: ChannelConfig;
  runtime: unknown;
};

export function createChannelAdapter({
  channelConfig,
  runtime,
}: CreateChannelAdapterParams): TelegramChannel | WhatsAppChannel {
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
