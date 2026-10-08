import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { connect } from 'net'
import { arch, platform, release, totalmem } from 'os'
import { join } from 'path'
import type { AppSettings, DiagItem, DiagReport, ProcState, ScanResult } from '../shared/types'
import { engineInfo } from './containers'
import { gitBin } from './git'
import * as redisOps from './redis'
import { dataDir } from './settings'
import { logCmd } from './cmdlog'

const isWin = process.platform === 'win32'

/** Corre "cmd args" pela shell (resolve .cmd/.bat no Windows) e devolve stdout+stderr; null se não existir. */
function tryRun(cmd: string, args: string[], timeoutMs = 15_000): Promise<{ out: string; code: number | null } | null> {
  return new Promise((resolve) => {
    // Sem JAVA_TOOL_OPTIONS (mesmo vazio o java imprime "Picked up JAVA_TOOL_OPTIONS")
    const { JAVA_TOOL_OPTIONS: _ignored, ...env } = process.env
    // Linha única pela shell (evita o aviso DEP0190 de args + shell:true)
    logCmd([cmd, ...args].join(' '), 'cmd')
    const t0 = Date.now()
    const child = spawn([cmd, ...args].join(' '), { shell: true, windowsHide: true, env })
    let out = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.on('data', (d) => (out += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      logCmd(e.message, 'err')
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      logCmd(`exit ${code ?? 'null'} · ${Date.now() - t0} ms`, code === 0 ? 'ok' : 'err')
      // "not found" vem como exit 127 (sh) ou 9009 (cmd.exe), com mensagem na saída
      if (code === 127 || code === 9009 || /not found|não é reconhecido|not recognized/i.test(out)) resolve(null)
      else resolve({ out: out.trim(), code })
    })
  })
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ port, host: '127.0.0.1' })
    const done = (v: boolean): void => {
      s.destroy()
      resolve(v)
    }
    s.setTimeout(700, () => done(false))
    s.on('connect', () => done(true))
    s.on('error', () => done(false))
  })
}

function javaMajor(out: string): number | undefined {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(out)
  if (!m) return undefined
  const major = Number(m[1])
  return major === 1 ? Number(m[2]) : major
}

export async function runDiagnostics(ctx: { settings: AppSettings; scan: ScanResult | null; procs: ProcState[]; port: number }): Promise<DiagReport> {
  const { settings, scan, procs } = ctx
  const items: DiagItem[] = []
  const add = (group: string, name: string, status: DiagItem['status'], detail: string, hint?: string): void => {
    items.push({ group, name, status, detail, hint })
  }
  const running = new Map(procs.filter((p) => p.status === 'running' || p.status === 'starting').map((p) => [p.id, p]))

  // ---- App / sistema ----
  const nodeMajor = Number(process.versions.node.split('.')[0])
  add('App', 'System', 'info', `${platform()} ${release()} (${arch()}) · ${Math.round(totalmem() / 1024 ** 3)} GB RAM`)
  add('App', 'Node.js', nodeMajor >= 20 ? 'ok' : 'fail', `v${process.versions.node}`, nodeMajor >= 20 ? undefined : 'The app needs Node 20 or higher (https://nodejs.org)')
  add('App', 'Server', 'info', `http://localhost:${ctx.port} · settings at ${join(dataDir(), 'settings.json')}`)

  // ---- Java ----
  const javaHome = settings.javaHome || process.env.JAVA_HOME
  const javaCmd = settings.javaHome ? `"${join(settings.javaHome, 'bin', 'java')}"` : 'java'
  const java = await tryRun(javaCmd, ['-version'])
  if (!java) add('Java', 'java', 'fail', settings.javaHome ? `not found in ${settings.javaHome}\\bin` : 'not found in PATH', 'Install a JDK 21 (e.g. Adoptium Temurin) or set JAVA_HOME in Settings → Java / Maven')
  else {
    const major = javaMajor(java.out)
    const line = java.out.split('\n').find((l) => /version/i.test(l)) ?? java.out.split('\n')[0]
    add('Java', 'java', major === undefined ? 'warn' : major >= 21 ? 'ok' : major >= 17 ? 'warn' : 'fail', line,
      major !== undefined && major < 21 ? 'Spring Boot 3 needs Java 17+; Keycloak 26 needs Java 21' : undefined)
  }
  add('Java', 'JAVA_HOME', javaHome ? (existsSync(javaHome) ? 'ok' : 'fail') : 'info', javaHome ?? 'not set (uses java from PATH)', javaHome && !existsSync(javaHome) ? 'The folder does not exist' : undefined)

  // ---- Maven / Git ----
  const mvn = await tryRun(settings.mavenCommand || 'mvn', ['-v'])
  const withWrapper = scan?.services.filter((s) => s.wrapperDir).length ?? 0
  const total = scan?.services.length ?? 0
  if (mvn) add('Build', `Maven (${settings.mavenCommand || 'mvn'})`, 'ok', mvn.out.split('\n').find((l) => /Apache Maven/.test(l)) ?? mvn.out.split('\n')[0])
  else add('Build', `Maven (${settings.mavenCommand || 'mvn'})`, total && withWrapper === total ? 'info' : 'warn', 'not found in PATH',
    total && withWrapper === total ? 'Not needed: all services have mvnw' : 'Install Maven or use projects with mvnw.cmd (Settings → prefer wrapper)')
  if (total) add('Build', 'Maven wrapper', withWrapper === total ? 'ok' : withWrapper ? 'warn' : 'info', `${withWrapper} of ${total} services have mvnw`, withWrapper < total && !mvn ? 'Services without a wrapper will not be able to start' : undefined)
  const repo = settings.mavenRepoLocal?.trim()
  if (repo) add('Build', 'Local Maven repository', existsSync(repo) ? 'ok' : 'warn', repo, existsSync(repo) ? undefined : 'The folder does not exist — Maven creates it on the first build (check the path)')
  const mvnSettings = settings.mavenSettingsFile?.trim()
  if (mvnSettings) add('Build', 'settings.xml', existsSync(mvnSettings) ? 'ok' : 'fail', mvnSettings, existsSync(mvnSettings) ? undefined : 'File not found')
  const gitCmd = gitBin()
  const git = await tryRun(gitCmd === 'git' ? 'git' : `"${gitCmd}"`, ['--version'])
  add('Build', `Git (${gitCmd})`, git ? 'ok' : 'warn', git ? git.out.split('\n')[0] : gitCmd === 'git' ? 'not found in PATH' : 'not found',
    git ? undefined : 'The Git tab requires Git: install Git for Windows (https://git-scm.com) or set the full path to git.exe in Settings → Git command')

  // ---- Pasta raiz / serviços ----
  if (!settings.rootFolder) add('Services', 'Root folder', 'fail', 'not set', 'Settings → Microservices root folder')
  else if (!existsSync(settings.rootFolder)) add('Services', 'Root folder', 'fail', `${settings.rootFolder} does not exist`)
  else {
    add('Services', 'Root folder', 'ok', settings.rootFolder)
    if (!scan) add('Services', 'Scan', 'warn', 'not done yet', 'Click Rescan')
    else {
      const boots = scan.services.filter((s) => s.kind === 'spring-boot')
      const spis = scan.services.filter((s) => s.kind === 'keycloak-spi')
      add('Services', 'Detected', scan.services.length ? 'ok' : 'warn',
        `${boots.length} Spring Boot · ${spis.length} Keycloak SPI · ${scan.services.length - boots.length - spis.length} other Maven`,
        scan.services.length ? undefined : 'No pom.xml found up to 6 levels deep (target/, node_modules/, src/ are ignored)')
      const semPorta = boots.filter((s) => !s.configFiles.length)
      if (semPorta.length) add('Services', 'No application.yml', 'info', semPorta.map((s) => s.name).join(', '), 'Port assumed to be 8080; Swagger/Endpoints may fail')
      for (const s of boots) {
        const port = running.get(s.id)?.detectedPort ?? settings.services[s.id]?.port ?? s.port
        if (!port) continue
        const used = await portInUse(port)
        const byApp = running.has(s.id)
        add('Ports', `${s.name} :${port}`, byApp ? 'ok' : used ? 'warn' : 'ok', byApp ? 'running (started by the app)' : used ? 'in use by another process' : 'free',
          !byApp && used ? 'If you start this service it will fail with "Address already in use" — stop the other process or change server.port' : undefined)
      }
    }
  }

  // ---- Keycloak (container) ----
  add('Keycloak', 'Container', 'info', `${settings.keycloak.containerName} · ${settings.keycloak.image}`, 'Managed on the Keycloak page (requires the container engine)')
  const kcUsed = await portInUse(settings.keycloak.httpPort)
  add('Keycloak', `Port :${settings.keycloak.httpPort}`, running.has('keycloak') ? 'ok' : kcUsed ? 'warn' : 'info', running.has('keycloak') ? 'Keycloak running (container managed by the app)' : kcUsed ? 'in use by another process (another Keycloak?)' : 'free — Keycloak stopped')

  // ---- Containers / Redis ----
  const engine = await engineInfo(settings.containerCommand?.trim() || 'podman')
  if (!engine.available) add('Containers', engine.command, 'warn', engine.error ?? 'not found', 'Install Podman (or Docker and change the command in Settings); only affects the Containers and Redis pages')
  else {
    const m = engine.machines?.find((x) => x.isDefault) ?? engine.machines?.[0]
    add('Containers', engine.command, engine.error ? 'warn' : 'ok', `client ${engine.clientVersion ?? '?'}${engine.serverVersion ? ` · server ${engine.serverVersion}` : ''}${m ? ` · machine ${m.name} ${m.running ? 'running' : 'stopped'}` : ''}`,
      engine.error ? (m && !m.running ? 'The machine is stopped: Containers → Start machine' : engine.error) : undefined)
  }
  const redis = await redisOps.info(settings.redis)
  add('Redis', `${settings.redis.host}:${settings.redis.port}`, redis.connected ? 'ok' : 'info', redis.connected ? `v${redis.version} · ${redis.keys} keys · ${redis.usedMemory}` : redis.error ?? 'no connection',
    redis.connected ? undefined : 'Only needed if you use the Redis page: start the container there or adjust Settings → Redis')

  return { generatedAt: Date.now(), platform: `${platform()} ${arch()}`, items }
}
