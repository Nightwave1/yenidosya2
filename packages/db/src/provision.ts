import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pool, closePool } from './pool'

/**
 * Creates runtime DB roles:
 *  - app_user  : the API's normal DML role — subject to tenant RLS
 *  - app_admin : super-admin service role — BYPASSRLS
 * Use in production DATABASE_URL: postgresql://app_user:.../oleum
 */
async function provision(): Promise<void> {
  const sql = readFileSync(join(__dirname, '..', 'scripts', 'roles.sql'), 'utf8')
  await pool.query(sql)
  console.log('Roles provisioned (app_user, app_admin).')
}

provision()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(closePool)
