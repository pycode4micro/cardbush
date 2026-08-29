export {
  BotConfigError,
  BotConfigStore,
  botPlatformSpec,
  botPlatformSpecs,
} from "./botConfigStore.js";
export type { BotPlatform, BotPlatformSpec } from "./botConfigStore.js";
export {
  BotSupervisor,
  BotSupervisorError,
} from "./botSupervisor.js";
export type {
  BotAdapter,
  BotAdapterContext,
  BotAdapterFactory,
  BotRuntimeStatus,
  BotServiceStatus,
} from "./botSupervisor.js";
export {
  PRODUCT_HOST_IPC_PROTOCOL,
  ProductHost,
  ProductHostProtocolError,
  decodeProductHostCommand,
} from "./productHost.js";
export {
  DiscordGatewayAdapter,
  createDiscordAdapterFactory,
} from "./discordAdapter.js";
export type { DiscordAdapterDependencies } from "./discordAdapter.js";
export { identityIsAllowed } from "./conversation.js";
export type { ChatEnvelope, ChatReply, ConversationBackend } from "./conversation.js";
export type {
  ProductHostCommand,
  ProductHostFailure,
  ProductHostResult,
  WeixinAccountHost,
} from "./productHost.js";
