// Smoke test ponta-a-ponta contra a API HTTP: arranca o servidor numa porta própria, faz scan das
// test-fixtures, arranca o demo-service (Maven real), verifica Swagger, pára e valida o Keycloak detetado.
//   npm run smoke
import { spawn } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import type { KeycloakInfo, ProcState, ScanResult } from '../src/shared/types'

const PORT = 3299
const base = `http://127.0.0.1:${PORT}`
const root = resolve(process.argv[2] ?? join(__dirname, '..', 'test-fixtures'))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let failed = false
const check = (label: string, ok: boolean): void => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failed = true
}
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  const j = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(j.error ?? String(res.status))
  return j
}
async function waitState(id: string, pred: (s?: ProcState) => boolean, ms: number): Promise<ProcState | undefined> {
  const end = Date.now() + ms
  let st: ProcState | undefined
  while (Date.now() < end) {
    st = (await call<ProcState[]>('GET', '/api/procs')).find((s) => s.id === id)
    if (pred(st)) return st
    await sleep(1000)
  }
  return st
}

async function main(): Promise<void> {
const server = spawn('npx tsx src/server/index.ts --no-open', {
  shell: true, cwd: join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, MSM_PORT: String(PORT), MSM_DATA_DIR: mkdtempSync(join(tmpdir(), 'msm-smoke-')) }
})
server.stdout.on('data', (d: Buffer) => process.stdout.write(`[server] ${d}`))
server.stderr.on('data', (d: Buffer) => process.stdout.write(`[server] ${d}`))

try {
  let up = false
  for (let i = 0; i < 30 && !up; i++) {
    await sleep(500)
    up = await fetch(base + '/api/settings').then((r) => r.ok).catch(() => false)
  }
  check('servidor arrancou', up)
  if (!up) throw new Error('servidor não respondeu')

  const scan = await call<ScanResult>('POST', '/api/scan', { root })
  const names = scan.services.map((s) => `${s.kind}:${s.name}`)
  console.log('     serviços:', names.join(', '))
  check('scan encontrou demo-service, order-service, my-auth-spi', ['spring-boot:demo-service', 'spring-boot:order-service', 'keycloak-spi:my-auth-spi'].every((n) => names.includes(n)))
  check('order-service: porta 8081, /orders, springdoc /docs', (() => { const s = scan.services.find((x) => x.name === 'order-service'); return s?.port === 8081 && s.contextPath === '/orders' && s.swaggerPath === '/docs' && s.hasDatabase })())
  check('keycloak detetado no scan', !!scan.keycloakHome)
  const kc = await call<KeycloakInfo>('GET', '/api/kc/info')
  check(`kc/info válido, providers=${kc.providers.join(',')}`, kc.valid && kc.providers.includes('old-spi.jar'))

  const demo = scan.services.find((s) => s.name === 'demo-service')!
  await call('POST', `/api/services/${demo.id}/start`, { mode: 'debug' })
  const running = await waitState(demo.id, (s) => s?.status === 'running' || s?.status === 'crashed', 180_000)
  check(`demo-service a correr (porta detetada ${running?.detectedPort}, debug ${running?.debugPort})`, running?.status === 'running' && running.detectedPort === 8091)
  if (running?.status === 'running') {
    check('GET /swagger-ui/index.html = 200', (await fetch('http://localhost:8091/swagger-ui/index.html')).status === 200)
    const logs = await call<{ text: string }[]>('GET', `/api/procs/${demo.id}/logs`)
    check(`logs recebidos (${logs.length} linhas)`, logs.some((l) => /Started DemoApplication/.test(l.text)))
    await call('POST', `/api/procs/${demo.id}/stop`)
    const stopped = await waitState(demo.id, (s) => s?.status === 'stopped', 30_000)
    check('demo-service parado', stopped?.status === 'stopped')
    await sleep(1000)
    check('porta 8091 libertada', !(await fetch('http://localhost:8091/hello').then(() => true).catch(() => false)))
  }
} catch (e) {
  console.error('ERRO', e)
  failed = true
} finally {
  server.kill('SIGINT')
  await sleep(1500)
  server.kill('SIGKILL')
}
console.log(failed ? '\nSMOKE: FALHOU' : '\nSMOKE: OK')
process.exit(failed ? 1 : 0)
}

void main()
