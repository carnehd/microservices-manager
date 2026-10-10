import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { AppSettings } from '../shared/types'

const DEFAULTS: AppSettings = {
  containerCommand: 'podman',
  refreshMs: 5000,
  logsTail: 300,
  templates: [
    { name: 'Postgres 16', spec: { image: 'docker.io/library/postgres:16-alpine', name: 'postgres', detach: true, rm: false, restart: 'no', network: '', ports: [{ host: '5432', container: '5432', proto: 'tcp' }], env: [{ key: 'POSTGRES_PASSWORD', value: 'postgres' }], volumes: [], labels: [], healthCmd: 'pg_isready -U postgres', memory: '', cpus: '', extraArgs: '', command: '' } },
    { name: 'Redis 7', spec: { image: 'docker.io/library/redis:7-alpine', name: 'redis', detach: true, rm: false, restart: 'no', network: '', ports: [{ host: '6379', container: '6379', proto: 'tcp' }], env: [], volumes: [], labels: [], healthCmd: '', memory: '', cpus: '', extraArgs: '', command: '' } },
    { name: 'Keycloak dev', spec: { image: 'quay.io/keycloak/keycloak:26.7.4', name: 'keycloak', detach: true, rm: false, restart: 'no', network: '', ports: [{ host: '8080', container: '8080', proto: 'tcp' }], env: [{ key: 'KC_BOOTSTRAP_ADMIN_USERNAME', value: 'admin' }, { key: 'KC_BOOTSTRAP_ADMIN_PASSWORD', value: 'admin' }], volumes: [], labels: [], healthCmd: '', memory: '', cpus: '', extraArgs: '', command: 'start-dev' } },
    { name: 'Pub/Sub emulator', spec: { image: 'gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators', name: 'pubsub', detach: true, rm: false, restart: 'no', network: '', ports: [{ host: '8085', container: '8085', proto: 'tcp' }], env: [], volumes: [], labels: [], healthCmd: '', memory: '', cpus: '', extraArgs: '', command: 'gcloud beta emulators pubsub start --host-port=0.0.0.0:8085 --project=local-project' } },
    { name: 'Jar Spring Boot (JRE)', spec: { image: 'docker.io/library/eclipse-temurin:21-jre', name: 'app', detach: true, rm: false, restart: 'no', network: '', ports: [{ host: '8080', container: '8080', proto: 'tcp' }], env: [{ key: 'SERVER_PORT', value: '8080' }], volumes: [{ src: 'C:\\projetos\\app\\target', dst: '/app', ro: true }], labels: [], healthCmd: '', memory: '', cpus: '', extraArgs: '', command: 'sh -c "exec java -jar /app/*.jar"' } }
  ]
}

/** Pasta de dados: %APPDATA%\containers-manager no Windows, ~/.config/containers-manager nos outros. */
export function dataDir(): string {
  const base = process.platform === 'win32' ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming') : join(homedir(), '.config')
  return join(base, 'containers-manager')
}

const file = (): string => join(dataDir(), 'settings.json')
let cache: AppSettings | null = null

export function getSettings(): AppSettings {
  if (cache) return cache
  try {
    cache = { ...DEFAULTS, ...(JSON.parse(readFileSync(file(), 'utf8')) as Partial<AppSettings>) }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next: AppSettings = { ...getSettings(), ...patch }
  // campos opcionais esvaziados chegam como '' — removem-se para "limpar" funcionar
  for (const k of Object.keys(next) as Array<keyof AppSettings>) if (next[k] === '') delete next[k]
  if (!next.containerCommand?.trim()) next.containerCommand = 'podman'
  cache = next
  if (!existsSync(dirname(file()))) mkdirSync(dirname(file()), { recursive: true })
  writeFileSync(file(), JSON.stringify(next, null, 2))
  return next
}
