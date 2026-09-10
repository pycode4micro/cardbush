import { accountCommandSchema, accountsSnapshotSchema, managedAccountSchema, accountProviderSchema,
  type AccountAction, type AccountProvider, type ManagedAccount, type OpenAiAccountStatus } from '@cardbush/bush-protocol';

export const accountProviders: AccountProvider[] = [
  { id: 'openai', name: 'OpenAI', availability: 'available', category: 'apps', methods: ['oauth'], experimental: true,
    description: { zh: '为通过 OpenAI 连接的应用提供共享登录。', en: 'Shared sign-in for apps connected through OpenAI.' },
    detail: { zh: '当前为实验性接入，授权页可能显示 Codex。应用仍需各自授权；模型 API 凭据单独配置。退出会断开使用此账号的 CardBush 插件，本机退出不会撤销 ChatGPT 中的应用授权。', en: 'Experimental connection; the consent page may say Codex. Apps need their own grants. Model API credentials are configured separately. Sign-out disconnects CardBush plugins using this account without revoking grants in ChatGPT.' },
    documentationUrl: 'https://learn.chatgpt.com/docs/auth' },
  { id: 'claude', name: 'Claude', availability: 'planned', category: 'models', methods: ['api_key'], experimental: false,
    description: { zh: '计划统一管理 Claude API 凭据。', en: 'Planned management of Claude API credentials.' },
    detail: { zh: '第三方应用优先通过 Claude Console 的 API Key 或受支持云平台接入。订阅登录与 API 使用分开管理；当前还未接入账号中心。', en: 'Third-party apps should use a Claude Console API key or supported cloud provider. Subscription sign-in and API use are separate. This account integration is not implemented yet.' },
    documentationUrl: 'https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account' },
  { id: 'qq', name: 'QQ', availability: 'planned', category: 'identity', methods: ['oauth'], experimental: false,
    description: { zh: '计划支持 QQ 互联的账号身份授权。', en: 'Planned QQ Connect identity authorization.' },
    detail: { zh: '接入需要申请平台应用并配置回调。身份授权、QQ 机器人和消息能力将分别管理；当前还未开放登录。', en: 'Requires a registered application and callback configuration. Identity authorization, bots and messaging require separate integrations. Sign-in is not available yet.' },
    documentationUrl: 'https://cloud.tencent.com/document/product/1441/62653' },
  { id: 'wechat', name: '微信', availability: 'planned', category: 'identity', methods: ['oauth', 'qr_login'], experimental: false,
    description: { zh: '计划支持微信开放平台的身份授权。', en: 'Planned WeChat Open Platform identity authorization.' },
    detail: { zh: '微信登录、公众号和企业微信属于不同接入方式，需要分别申请能力。账号登录不会被当作个人聊天访问权限；当前还未开放扫码。', en: 'WeChat sign-in, Official Accounts and WeCom need separate integrations. Identity sign-in does not grant personal chat access. QR sign-in is not available yet.' },
    documentationUrl: 'https://docs.cloudbase.net/authentication-v2/method/wechat-login' },
  { id: 'bilibili', name: 'bilibili', availability: 'planned', category: 'content', methods: ['oauth'], experimental: false,
    description: { zh: '计划接入创作者授权、内容与数据能力。', en: 'Planned creator authorization, content and data access.' },
    detail: { zh: '优先使用 Bilibili 开放平台，完成入驻和应用接入后按授权范围启用功能。事件通知可进一步对接自动化；当前尚未接入。', en: 'Use the Bilibili Open Platform with an approved application and scoped grants. Event notifications can later connect to automations. This integration is not implemented yet.' },
    documentationUrl: 'https://open.bilibili.com/doc' },
];

export interface AccountAdapter {
  providerId: string;
  list: () => Promise<ManagedAccount[]>;
  action: (accountId: string, action: AccountAction) => Promise<void>;
}

/** Public account metadata only. Adapters retain ownership of credentials and auth flows. */
export class AccountManager {
  private readonly adapters: Map<string, AccountAdapter>;
  private readonly providers: AccountProvider[];
  constructor(adapters: AccountAdapter[], providers = accountProviders) {
    this.providers = providers.map(provider => accountProviderSchema.parse(provider));
    this.adapters = new Map();
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.providerId) || !this.providers.some(provider => provider.id === adapter.providerId && provider.availability === 'available')) throw new Error('Invalid or duplicate account adapter.');
      this.adapters.set(adapter.providerId, adapter);
    }
  }
  private async listAdapter(adapter: AccountAdapter) {
    const accounts = (await adapter.list()).map(item => managedAccountSchema.parse(item));
    if (accounts.some(account => account.providerId !== adapter.providerId) || new Set(accounts.map(account=>account.id)).size !== accounts.length) throw new Error('Invalid account ownership.');
    return accounts;
  }
  async snapshot() {
    const adapters = [...this.adapters.values()];
    const results = await Promise.allSettled(adapters.map(adapter => this.listAdapter(adapter)));
    return accountsSnapshotSchema.parse({ providers: this.providers,
      accounts: results.flatMap(result => result.status === 'fulfilled' ? result.value : []),
      errors: results.flatMap((result, index) => result.status === 'rejected' ? [{ providerId: adapters[index]!.providerId, code: 'unavailable' }] : []),
    });
  }
  async action(input: unknown) {
    const command = accountCommandSchema.parse(input), adapter = this.adapters.get(command.providerId);
    if (!adapter) throw new Error('This account provider is not connected yet.');
    const account = (await this.listAdapter(adapter)).find(account => account.id === command.accountId);
    if (!account || !account.actions.includes(command.action)) throw new Error('This action is unavailable for the selected account.');
    await adapter.action(command.accountId, command.action);
    return this.snapshot();
  }
}

export function openAiAccountSummary(status: OpenAiAccountStatus): ManagedAccount {
  return { id: 'openai:default', providerId: 'openai', label: 'OpenAI', state: status.state,
    actions: status.state === 'signing_in' ? ['cancel_login'] : status.state === 'unavailable' ? ['logout']
      : status.state === 'signed_in' ? ['login', 'manage_apps', 'reconnect', 'logout'] : status.state === 'reauth_required' ? ['login', 'manage_apps', 'logout'] : ['login', 'manage_apps'],
    ...(status.lastError ? { lastError: status.lastError } : {}) };
}
