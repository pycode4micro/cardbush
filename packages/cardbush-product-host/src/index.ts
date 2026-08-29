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
export type {
  BotPermissionRequest,
  ChatEnvelope,
  ChatReply,
  ConversationBackend,
} from "./conversation.js";
export {
  FeishuLongConnectionAdapter,
  createFeishuAdapterFactory,
} from "./feishuAdapter.js";
export {
  WeixinAccountManager,
  WeixinAccountStore,
  WeixinApiClient,
  WeixinPollingAdapter,
  createWeixinAdapterFactory,
} from "./weixinAdapter.js";
export type {
  WeixinAccount,
  WeixinAdapterDependencies,
} from "./weixinAdapter.js";
export type {
  FeishuAdapterDependencies,
  FeishuConnector,
  FeishuMessageEvent,
} from "./feishuAdapter.js";
export type {
  ProductHostCommand,
  ProductHostFailure,
  ProductHostResult,
  WeixinAccountHost,
} from "./productHost.js";
