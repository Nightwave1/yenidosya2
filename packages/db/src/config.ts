import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * Loads the nearest `.env` walking up from CWD (repo root in practice)
 * into process.env. Existing environment variables always win.
 */
export function loadEnv(): void {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, '.env')
    if (existsSync(candidate)) {
      for (const line of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
        if (!m) continue
        const key = m[1]
        if (process.env[key] === undefined) {
          process.env[key] = m[2].replace(/^['"]|['"]$/g, '')
        }
      }
      break
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
}

// Load once on first import of this module.
loadEnv()

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (v === undefined || v === '') {
    throw new Error(`Missing required env: ${name}`)
  }
  return v
}

export const env = {
  get DATABASE_URL(): string {
    return required('DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/oleum')
  },
  get REDIS_URL(): string | undefined {
    return process.env.REDIS_URL || undefined
  },
  get PORT(): number {
    return Number(process.env.PORT ?? 4000)
  },
  get JWT_SECRET(): string {
    return required('JWT_SECRET', 'dev-only-change-me-32+chars')
  },
  get APP_BASE_URL(): string {
    return process.env.APP_BASE_URL ?? 'http://localhost:5173'
  },
}
