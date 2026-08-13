export interface AppEnv {
  PORT?: string
  AGENTS_API_BASE_URL?: string
  AGENTS_API_TIMEOUT_MS?: string
  AGENTS_API_MAX_PAGES?: string
  API_KEY_HASHES?: string
  TURSO_DATABASE_URL?: string
  TURSO_AUTH_TOKEN?: string
  WEBHOOK_PUBLIC_BASE_URL?: string
  WEBHOOK_POLL_ENABLED?: string
  WEBHOOK_POLL_INTERVAL_MS?: string
  INTERNAL_WEBHOOK_SECRET?: string
}
