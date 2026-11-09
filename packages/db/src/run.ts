import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pool, closePool } from './pool'

const dir = join(__dirname, '..', 'migrations')

async function up(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
  const applied = new Set(
    (await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string),
  )
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const file of files) {
    if (applied.has(file)) continue
    const sql = readFileSync(join(dir, file), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
      await client.query('COMMIT')
      console.log(`✔ applied  ${file}`)
    } catch (e) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* noop */
      }
      throw new Error(`Migration ${file} failed: ${(e as Error).message}`)
    } finally {
      client.release()
    }
  }
  console.log('Database is up to date.')
}

up()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(closePool)
