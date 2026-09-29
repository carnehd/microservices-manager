import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { AppSettings } from '../shared/types'

const DEFAULTS: AppSettings = {
  mavenCommand: 'mvn',
  preferWrapper: true,
  baseDebugPort: 5005,
  keycloak: { httpPort: 8080, adminUser: 'admin', adminPassword: 'admin', containerName: 'msm-keycloak', image: 'quay.io/keycloak/keycloak:26.7.4' },
  redis: { host: 'localhost', port: 6379, db: 0, containerName: 'msm-redis', image: 'docker.io/library/redis:7-alpine' },
  postgres: { containerName: 'msm-postgres', image: 'docker.io/library/postgres:16-alpine', port: 5432, superUser: 'postgres', superPassword: 'postgres' },
  services: {}
}

let cache: AppSettings | null = null

/** %APPDATA%\microservices-manager no Windows, ~/.config/microservices-manager noutros; MSM_DATA_DIR sobrepõe. */
export function dataDir(): string {
  if (process.env.MSM_DATA_DIR) return process.env.MSM_DATA_DIR
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'microservices-manager')
  return join(homedir(), '.config', 'microservices-manager')
}

function settingsFile(): string {
  return join(dataDir(), 'settings.json')
}

export function getSettings(): AppSettings {
  if (cache) return cache
  let loaded: Partial<AppSettings> = {}
  try {
    loaded = JSON.parse(readFileSync(settingsFile(), 'utf8'))
  } catch {
    /* primeira execução: sem ficheiro */
  }
  // chaves de versões antigas (modo standalone) já não existem
  const kcLoaded = { ...(loaded.keycloak ?? {}) } as Record<string, unknown>
  delete kcLoaded.mode
  delete kcLoaded.home
  cache = {
    ...DEFAULTS,
    ...loaded,
    keycloak: { ...DEFAULTS.keycloak, ...(kcLoaded as Partial<AppSettings['keycloak']>) },
    redis: { ...DEFAULTS.redis, ...(loaded.redis ?? {}) },
    postgres: { ...DEFAULTS.postgres, ...(loaded.postgres ?? {}) },
    services: loaded.services ?? {}
  }
  return cache
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const next: AppSettings = {
    ...current,
    ...patch,
    keycloak: { ...current.keycloak, ...(patch.keycloak ?? {}) },
    redis: { ...current.redis, ...(patch.redis ?? {}) },
    postgres: { ...current.postgres, ...(patch.postgres ?? {}) },
    services: patch.services ?? current.services
  }
  cache = next
  const file = settingsFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(next, null, 2))
  return next
}
