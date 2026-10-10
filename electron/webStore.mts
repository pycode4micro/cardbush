import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { digest, WebError, type WebConversation, type WebUser } from './webCommon.mjs';
import { WebOrganizationStore, userColumns, userJoin } from './webOrganization.mjs';
import { hashWebPassword, verifyWebPassword } from './webPasswords.mjs';
export { hashWebPassword, verifyWebPassword } from './webPasswords.mjs';

const registration = z.object({ username: z.string().trim().min(3).max(80).regex(/^[A-Za-z0-9_.-]+$/), display_name: z.string().trim().min(1).max(120), password: z.string().min(8).max(128), department_id: z.string().max(64).nullable().optional() }).strict();
export type WebPluginState = { installed: boolean; enabled: boolean; grants: string[] };
export interface WebStore {
  plugin(): Promise<WebPluginState>;
  updatePlugin(actor: WebUser, input: unknown): Promise<WebPluginState>;
  grantPlugin(actor: WebUser, userId: string, enabled: boolean): Promise<WebPluginState>;
  imageAllowed(userId: string): Promise<boolean>;
  authenticate(token: string): Promise<WebUser | null>;
  login(input: unknown): Promise<{ token: string; user: WebUser }>;
  register(input: unknown): Promise<{ message: string }>;
  logout(token: string): Promise<void>;
  user(id: string, includeDeleted?: boolean): Promise<WebUser | null>;
  departments(): Promise<Array<{ id: string; name: string }>>;
  organization: WebOrganizationStore['organization'];
  saveCompany: WebOrganizationStore['saveCompany'];
  deleteCompany: WebOrganizationStore['deleteCompany'];
  saveDepartment: WebOrganizationStore['saveDepartment'];
  deleteDepartment: WebOrganizationStore['deleteDepartment'];
  createUser: WebOrganizationStore['createUser'];
  deleteUser: WebOrganizationStore['deleteUser'];
  restoreUser: WebOrganizationStore['restoreUser'];
  users(deleted?: boolean): Promise<WebUser[]>;
  updateUser(actor: WebUser, id: string, input: unknown): Promise<WebUser>;
  list(userId: string): Promise<WebConversation[]>;
  conversation(userId: string, id: string): Promise<WebConversation>;
  create(userId: string, id: string, title: string): Promise<WebConversation>;
  update(userId: string, id: string, input: unknown): Promise<WebConversation>;
  remove(userId: string, id: string): Promise<void>;
  touch(userId: string, id: string, text: string): Promise<void>;
}

export class PostgresWebStore extends WebOrganizationStore implements WebStore {
  constructor(connectionString: string) { super(new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 10_000 })); }
  async migrate() {
    // Existing identity tables are reused unchanged. These definitions also allow
    // a fresh standalone installation; all new conversation state is namespaced.
    await this.pool.query(`CREATE TABLE IF NOT EXISTS departments (id varchar(64) PRIMARY KEY, name varchar(120) UNIQUE NOT NULL, description varchar(500), is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS user_accounts (id varchar(64) PRIMARY KEY, username varchar(80) UNIQUE NOT NULL, display_name varchar(120) NOT NULL, password_hash varchar(300) NOT NULL, role varchar(40) NOT NULL DEFAULT 'member', department_id varchar(64) REFERENCES departments(id), module_permissions json NOT NULL DEFAULT '[]', is_active boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), last_login_at timestamptz);
      CREATE TABLE IF NOT EXISTS auth_sessions (id varchar(64) PRIMARY KEY, user_id varchar(64) NOT NULL REFERENCES user_accounts(id), token_hash varchar(64) UNIQUE NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz);
      CREATE TABLE IF NOT EXISTS cardbush_web_conversations (id varchar(64) PRIMARY KEY, user_id varchar(64) NOT NULL REFERENCES user_accounts(id), title varchar(200) NOT NULL, pinned boolean NOT NULL DEFAULT false, archived boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS cardbush_web_plugins (id text PRIMARY KEY CHECK (id='volcengine_images'), installed boolean NOT NULL DEFAULT false, enabled boolean NOT NULL DEFAULT false);
      INSERT INTO cardbush_web_plugins(id) VALUES('volcengine_images') ON CONFLICT DO NOTHING;
      CREATE TABLE IF NOT EXISTS cardbush_web_plugin_grants (user_id varchar(64) PRIMARY KEY REFERENCES user_accounts(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS cardbush_web_conversations_owner ON cardbush_web_conversations(user_id,updated_at DESC);`);
    await this.migrateOrganization();
  }
  async plugin(): Promise<WebPluginState> {
    const state = (await this.pool.query("SELECT installed,enabled FROM cardbush_web_plugins WHERE id='volcengine_images'")).rows[0];
    return { ...state, grants: (await this.pool.query('SELECT user_id FROM cardbush_web_plugin_grants')).rows.map(row => row.user_id) };
  }
  async updatePlugin(actor: WebUser, input: unknown) {
    if (actor.role !== 'admin') throw new WebError(403, '需要管理员权限。');
    const { action } = z.object({ action: z.enum(['install','enable','disable','uninstall']) }).strict().parse(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT id FROM cardbush_web_plugins WHERE id='volcengine_images' FOR UPDATE");
      if (action === 'uninstall') await client.query('DELETE FROM cardbush_web_plugin_grants');
      if (action === 'install' || action === 'uninstall') await client.query("UPDATE cardbush_web_plugins SET installed=$1,enabled=$1 WHERE id='volcengine_images'", [action === 'install']);
      else await client.query("UPDATE cardbush_web_plugins SET enabled=installed AND $1 WHERE id='volcengine_images'", [action === 'enable']);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return this.plugin();
  }
  async grantPlugin(actor: WebUser, userId: string, enabled: boolean) {
    if (actor.role !== 'admin') throw new WebError(403, '需要管理员权限。');
    if (!await this.user(userId)) throw new WebError(404, '账号不存在。');
    if (enabled) {
      const result = await this.pool.query("INSERT INTO cardbush_web_plugin_grants(user_id) SELECT $1 WHERE EXISTS (SELECT 1 FROM cardbush_web_plugins WHERE installed) ON CONFLICT DO NOTHING", [userId]);
      if (!result.rowCount && !(await this.plugin()).installed) throw new WebError(409, '请先安装图片插件。');
    } else await this.pool.query('DELETE FROM cardbush_web_plugin_grants WHERE user_id=$1', [userId]);
    return this.plugin();
  }
  async imageAllowed(userId: string) {
    return Boolean((await this.pool.query("SELECT 1 FROM cardbush_web_plugin_grants g JOIN user_accounts u ON u.id=g.user_id CROSS JOIN cardbush_web_plugins p WHERE g.user_id=$1 AND u.is_active AND p.installed AND p.enabled", [userId])).rowCount);
  }
  async authenticate(token: string): Promise<WebUser | null> {
    if (!token) return null;
    return (await this.pool.query(`SELECT ${userColumns} FROM auth_sessions s JOIN user_accounts u ON u.id=s.user_id ${userJoin} WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.is_active AND u.deleted_at IS NULL`, [digest(token)])).rows[0] ?? null;
  }
  async login(input: unknown) {
    const value = z.object({ username: z.string().trim().min(1).max(80), password: z.string().min(1).max(128) }).strict().parse(input);
    const row = (await this.pool.query('SELECT id,password_hash,is_active FROM user_accounts WHERE lower(username)=$1 AND deleted_at IS NULL', [value.username.toLowerCase()])).rows[0];
    // Do the same expensive hash operation for unknown users.
    const valid = await verifyWebPassword(value.password, row?.password_hash ?? 'scrypt$16384$8$1$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000');
    if (!row || !valid) throw new WebError(401, '用户名或密码错误。');
    if (!row.is_active) throw new WebError(403, '账号尚未启用，请联系管理员。');
    const token = randomBytes(40).toString('base64url');
    await this.pool.query("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at,created_at) VALUES($1,$2,$3,now()+interval '24 hours',now())", [`auth_${randomUUID()}`, row.id, digest(token)]);
    await this.pool.query('UPDATE user_accounts SET last_login_at=now() WHERE id=$1', [row.id]);
    return { token, user: (await this.user(row.id))! };
  }
  async register(input: unknown) {
    const value = registration.parse(input), passwordHash = await hashWebPassword(value.password);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(47805199)');
      if (value.department_id && !(await client.query('SELECT id FROM departments WHERE id=$1 AND is_active', [value.department_id])).rowCount) throw new WebError(400, '请选择有效的部门。');
      const first = Number((await client.query('SELECT count(*) AS count FROM user_accounts')).rows[0].count) === 0;
      await client.query('INSERT INTO user_accounts(id,username,display_name,password_hash,role,department_id,module_permissions,is_active,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),now())',
        [`usr_${randomUUID()}`, value.username.toLowerCase(), value.display_name, passwordHash, first ? 'admin' : 'member', value.department_id || null, JSON.stringify(first ? ['admin'] : []), first]);
      await client.query('COMMIT'); return { message: first ? '管理员账号已创建，请登录。' : '注册成功，请等待管理员启用账号。' };
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') throw new WebError(409, '用户名已存在。');
      throw error;
    } finally { client.release(); }
  }
  async logout(token: string) { await this.pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1', [digest(token)]); }
  async list(userId: string): Promise<WebConversation[]> { return (await this.pool.query('SELECT id,title,pinned,archived,created_at,updated_at FROM cardbush_web_conversations WHERE user_id=$1 ORDER BY pinned DESC,updated_at DESC', [userId])).rows; }
  async conversation(userId: string, id: string): Promise<WebConversation> {
    const row = (await this.pool.query('SELECT id,title,pinned,archived,created_at,updated_at FROM cardbush_web_conversations WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
    if (!row) throw new WebError(404, '会话不存在。'); return row;
  }
  async create(userId: string, id: string, title: string) {
    await this.pool.query('INSERT INTO cardbush_web_conversations(id,user_id,title) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [id, userId, title]);
    return this.conversation(userId, id);
  }
  async update(userId: string, id: string, input: unknown) {
    const value = z.object({ title: z.string().trim().min(1).max(200).optional(), pinned: z.boolean().optional(), archived: z.boolean().optional() }).strict().parse(input);
    await this.conversation(userId, id);
    await this.pool.query('UPDATE cardbush_web_conversations SET title=COALESCE($3,title),pinned=COALESCE($4,pinned),archived=COALESCE($5,archived),updated_at=now() WHERE id=$1 AND user_id=$2', [id, userId, value.title ?? null, value.pinned ?? null, value.archived ?? null]);
    return this.conversation(userId, id);
  }
  async remove(userId: string, id: string) { await this.pool.query('DELETE FROM cardbush_web_conversations WHERE id=$1 AND user_id=$2', [id, userId]); }
  async touch(userId: string, id: string, text: string) { await this.pool.query("UPDATE cardbush_web_conversations SET updated_at=now(),title=CASE WHEN title='新对话' THEN $3 ELSE title END WHERE id=$1 AND user_id=$2", [id, userId, text.slice(0, 40)]); }
}
