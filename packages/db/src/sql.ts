import type { PoolClient } from 'pg'
import { pool } from './pool'

/**
 * Minimal query interface handed to repository code.
 * Stays deliberately thin — complex time/range SQL lives in the repositories
 * as parameterized text.
 */
export interface SqlQueryClient {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<T[]>
}

export async function withTenant<T>(
  tenantId: string,
  fn: (sql: SqlQueryClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId])
    const out = await fn(bind(client))
    await client.query('COMMIT')
    return out
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* connection already broken */
    }
    throw e
  } finally {
    client.release()
  }
}

/**
 * Transaction without a tenant context — platform-level/super-admin queries
 * (must run as a role that bypasses RLS, e.g. the provider owner or app_admin).
 */
export async function withSystem<T>(fn: (sql: SqlQueryClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(bind(client))
    await client.query('COMMIT')
    return out
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* connection already broken */
    }
    throw e
  } finally {
    client.release()
  }
}

function bind(client: PoolClient): SqlQueryClient {
  const impl = async <T>(text: string, values?: readonly unknown[]): Promise<T[]> => {
    const res = await client.query(text, values ? [...values] : [])
    return res.rows as unknown as T[]
  }
  return {
    query: impl,
  }
}
