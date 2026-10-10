import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { WebError, type WebUser, type WebCompany, type WebDepartment } from './webCommon.mjs';
import { hashWebPassword } from './webPasswords.mjs';

const roles = ['admin', 'department_admin', 'member'] as const;
const username = z.string().trim().min(3).max(80).regex(/^[A-Za-z0-9_.-]+$/).transform(value => value.toLowerCase());
const name = z.string().trim().min(1).max(120);
const id = z.string().min(1).max(64);
const companyInput = z.object({ name, description: z.string().trim().max(500).default('') }).strict();
const departmentInput = companyInput.extend({ company_id: id }).strict();
const accountInput = z.object({ username, display_name: name, password: z.string().min(8).max(128), role: z.enum(roles).default('member'), is_active: z.boolean().default(true), department_id: id.nullable().optional() }).strict();
const accountChanges = z.object({ username: username.optional(), display_name: name.optional(), role: z.enum(roles).optional(), is_active: z.boolean().optional(), department_id: id.nullable().optional(), new_password: z.string().min(8).max(128).optional() }).strict().refine(value => Object.keys(value).length > 0, '请填写要修改的字段。');
export const userColumns = 'u.id,u.username,u.display_name,u.role,u.is_active,u.department_id,u.deleted_at,d.name AS department_name,d.company_id,c.name AS company_name';
export const userJoin = 'LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN cardbush_web_companies c ON c.id=d.company_id';
type Query = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;
async function readUser(db: Query, userId: string, includeDeleted = false): Promise<WebUser | null> {
  return (await db.query(`SELECT ${userColumns} FROM user_accounts u ${userJoin} WHERE u.id=$1 AND ($2 OR u.deleted_at IS NULL)`, [userId, includeDeleted])).rows[0] ?? null;
}

/** Organization changes never move tenant volumes or grant access to another person's conversations. */
export class WebOrganizationStore {
  constructor(readonly pool: pg.Pool) {}
  async migrateOrganization() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN; SELECT pg_advisory_xact_lock(47805198)');
      await client.query(`CREATE TABLE IF NOT EXISTS cardbush_web_companies (id varchar(64) PRIMARY KEY, name varchar(120) UNIQUE NOT NULL, description varchar(500) NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
        ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
        ALTER TABLE departments ADD COLUMN IF NOT EXISTS company_id varchar(64) REFERENCES cardbush_web_companies(id);
        INSERT INTO cardbush_web_companies(id,name) SELECT 'company_legacy','原有组织' WHERE EXISTS (SELECT 1 FROM departments WHERE company_id IS NULL) ON CONFLICT(id) DO NOTHING;
        UPDATE departments SET company_id='company_legacy' WHERE company_id IS NULL;
        ALTER TABLE departments ALTER COLUMN company_id SET NOT NULL;
        DO $$ DECLARE constraint_name text; BEGIN
          FOR constraint_name IN SELECT c.conname FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname='name' WHERE c.conrelid='departments'::regclass AND c.contype='u' AND c.conkey=ARRAY[a.attnum] LOOP
            EXECUTE format('ALTER TABLE departments DROP CONSTRAINT %I',constraint_name);
          END LOOP;
        END $$;
        CREATE UNIQUE INDEX IF NOT EXISTS cardbush_web_department_company_name ON departments(company_id,name);
        CREATE INDEX IF NOT EXISTS cardbush_web_people_department ON user_accounts(department_id) WHERE deleted_at IS NULL;`);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  private async adminTransaction<T>(actor: WebUser, operation: (client: pg.PoolClient) => Promise<T>) {
    if (actor.role !== 'admin') throw new WebError(403, '需要管理员权限。');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN; SELECT pg_advisory_xact_lock(47805199)');
      const current = (await client.query('SELECT role,is_active,deleted_at FROM user_accounts WHERE id=$1 FOR UPDATE', [actor.id])).rows[0];
      if (!current || current.role !== 'admin' || !current.is_active || current.deleted_at) throw new WebError(403, '管理员权限已失效。');
      const result = await operation(client); await client.query('COMMIT'); return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') throw new WebError(409, '名称或用户名已存在；不同公司可以使用相同部门名称。');
      if ((error as { code?: string }).code === '23503') throw new WebError(409, '仍有关联数据，请先调整下级归属。');
      throw error;
    } finally { client.release(); }
  }
  async companies(): Promise<WebCompany[]> {
    return (await this.pool.query(`SELECT c.id,c.name,c.description,
      (SELECT count(*)::int FROM departments d WHERE d.company_id=c.id) AS department_count,
      (SELECT count(*)::int FROM user_accounts u JOIN departments d ON d.id=u.department_id WHERE d.company_id=c.id AND u.deleted_at IS NULL) AS member_count
      FROM cardbush_web_companies c ORDER BY c.name,c.id`)).rows;
  }
  async organization() {
    const [companies, departments] = await Promise.all([this.companies(), this.departmentRecords()]);
    return { companies, departments };
  }
  async departmentRecords(): Promise<WebDepartment[]> {
    return (await this.pool.query(`SELECT d.id,d.name,d.description,d.company_id,c.name AS company_name,d.is_active,
      (SELECT count(*)::int FROM user_accounts u WHERE u.department_id=d.id AND u.deleted_at IS NULL) AS member_count
      FROM departments d JOIN cardbush_web_companies c ON c.id=d.company_id ORDER BY c.name,d.name,d.id`)).rows;
  }
  async departments() { return (await this.departmentRecords()).filter(department => department.is_active).map(({ id, name, company_id, company_name }) => ({ id, name, company_id, company_name })); }
  async saveCompany(actor: WebUser, companyId: string | null, input: unknown) {
    const value = companyInput.parse(input);
    return this.adminTransaction(actor, async client => {
      const result = companyId
        ? await client.query('UPDATE cardbush_web_companies SET name=$2,description=$3,updated_at=now() WHERE id=$1 RETURNING id,name,description', [companyId, value.name, value.description])
        : await client.query('INSERT INTO cardbush_web_companies(id,name,description) VALUES($1,$2,$3) RETURNING id,name,description', [`company_${randomUUID()}`, value.name, value.description]);
      if (!result.rowCount) throw new WebError(404, '公司不存在。'); return result.rows[0];
    });
  }
  async deleteCompany(actor: WebUser, companyId: string) {
    return this.adminTransaction(actor, async client => {
      if ((await client.query('SELECT 1 FROM departments WHERE company_id=$1 LIMIT 1', [companyId])).rowCount) throw new WebError(409, '公司下仍有部门，请先转移或删除部门。');
      if (!(await client.query('DELETE FROM cardbush_web_companies WHERE id=$1', [companyId])).rowCount) throw new WebError(404, '公司不存在。');
    });
  }
  async saveDepartment(actor: WebUser, departmentId: string | null, input: unknown) {
    const value = departmentInput.parse(input);
    return this.adminTransaction(actor, async client => {
      if (!(await client.query('SELECT 1 FROM cardbush_web_companies WHERE id=$1', [value.company_id])).rowCount) throw new WebError(400, '请选择有效的公司。');
      const result = departmentId
        ? await client.query('UPDATE departments SET name=$2,description=$3,company_id=$4,updated_at=now() WHERE id=$1 RETURNING id,name,description,company_id,is_active', [departmentId,value.name,value.description,value.company_id])
        : await client.query('INSERT INTO departments(id,name,description,company_id,is_active,created_at,updated_at) VALUES($1,$2,$3,$4,true,now(),now()) RETURNING id,name,description,company_id,is_active', [`dept_${randomUUID()}`,value.name,value.description,value.company_id]);
      if (!result.rowCount) throw new WebError(404, '部门不存在。'); return result.rows[0];
    });
  }
  async deleteDepartment(actor: WebUser, departmentId: string) {
    return this.adminTransaction(actor, async client => {
      if ((await client.query('SELECT 1 FROM user_accounts WHERE department_id=$1 LIMIT 1', [departmentId])).rowCount) throw new WebError(409, '部门内仍有人员，请先调整人员归属。');
      if (!(await client.query('DELETE FROM departments WHERE id=$1', [departmentId])).rowCount) throw new WebError(404, '部门不存在。');
    });
  }
  async user(userId: string, includeDeleted = false) { return readUser(this.pool, userId, includeDeleted); }
  async users(deleted = false): Promise<WebUser[]> {
    return (await this.pool.query(`SELECT ${userColumns} FROM user_accounts u ${userJoin} WHERE (u.deleted_at IS NOT NULL)=$1 ORDER BY u.created_at DESC,u.id`, [deleted])).rows;
  }
  private async checkDepartment(client: pg.PoolClient, departmentId: string | null | undefined) {
    if (departmentId && !(await client.query('SELECT 1 FROM departments WHERE id=$1 AND is_active', [departmentId])).rowCount) throw new WebError(400, '请选择有效的部门。');
  }
  async createUser(actor: WebUser, input: unknown) {
    const value = accountInput.parse(input);
    if (actor.role !== 'admin') throw new WebError(403, '需要管理员权限。');
    const hash = await hashWebPassword(value.password);
    return this.adminTransaction(actor, async client => {
      await this.checkDepartment(client, value.department_id); const userId = `usr_${randomUUID()}`;
      await client.query('INSERT INTO user_accounts(id,username,display_name,password_hash,role,is_active,department_id,module_permissions,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),now())', [userId,value.username,value.display_name,hash,value.role,value.is_active,value.department_id ?? null,JSON.stringify(value.role==='admin'?['admin']:[])]);
      return (await readUser(client,userId))!;
    });
  }
  async updateUser(actor: WebUser, userId: string, input: unknown) {
    const value = accountChanges.parse(input);
    if (actor.role !== 'admin') throw new WebError(403, '需要管理员权限。');
    if (actor.id === userId && (value.is_active === false || value.role && value.role !== 'admin')) throw new WebError(409, '不能停用或降低自己的管理员权限。');
    const hash = value.new_password ? await hashWebPassword(value.new_password) : null;
    return this.adminTransaction(actor, async client => {
      await this.checkDepartment(client,value.department_id);
      const previous = await readUser(client,userId);
      if (!previous) throw new WebError(404, '账号不存在或已删除。');
      await client.query(`UPDATE user_accounts SET username=COALESCE($2,username),display_name=COALESCE($3,display_name),role=COALESCE($4,role),is_active=COALESCE($5,is_active),
        department_id=CASE WHEN $6 THEN $7 ELSE department_id END,password_hash=COALESCE($8,password_hash),updated_at=now() WHERE id=$1`, [userId,value.username ?? null,value.display_name ?? null,value.role ?? null,value.is_active ?? null,Object.hasOwn(value,'department_id'),value.department_id ?? null,hash]);
      if (value.is_active === false || hash || value.role !== undefined && value.role !== previous.role || value.username !== undefined && value.username !== previous.username) await client.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[userId]);
      return (await readUser(client,userId))!;
    });
  }
  async deleteUser(actor: WebUser, userId: string) {
    if (actor.id === userId) throw new WebError(409, '不能删除当前登录的管理员。');
    return this.adminTransaction(actor, async client => {
      if (!(await client.query('UPDATE user_accounts SET is_active=false,deleted_at=now(),department_id=NULL,updated_at=now() WHERE id=$1 AND deleted_at IS NULL',[userId])).rowCount) throw new WebError(404, '账号不存在或已删除。');
      await client.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[userId]);
      await client.query('DELETE FROM cardbush_web_plugin_grants WHERE user_id=$1',[userId]);
    });
  }
  async restoreUser(actor: WebUser, userId: string) {
    return this.adminTransaction(actor, async client => {
      if (!(await client.query('UPDATE user_accounts SET deleted_at=NULL,is_active=false,updated_at=now() WHERE id=$1 AND deleted_at IS NOT NULL',[userId])).rowCount) throw new WebError(404, '已删除账号不存在。');
      return (await readUser(client,userId))!;
    });
  }
}
