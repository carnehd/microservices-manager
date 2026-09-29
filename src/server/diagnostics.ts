import { spawn } from 'child_process'
import { existsSync, statSync } from 'fs'
import { connect } from 'net'
import { arch, platform, release, totalmem } from 'os'
import { join } from 'path'
import type { AppSettings, DiagItem, DiagReport, ProcState, ScanResult } from '../shared/types'
import { engineInfo } from './containers'
import { keycloakInfo } from './keycloak'
import * as redisOps from './redis'
import { dataDir } from './settings'

const isWin = process.platform === 'win32'

/** Corre "cmd args" pela shell (resolve .cmd/.bat no Windows) e devolve stdout+stderr; null se não existir. */
function tryRun(cmd: string, args: string[], timeoutMs = 15_000): Promise<{ out: string; code: number | null } | null> {
  return new Promise((resolve) => {
    // Sem JAVA_TOOL_OPTIONS (mesmo vazio o java imprime "Picked up JAVA_TOOL_OPTIONS")
    const { JAVA_TOOL_OPTIONS: _ignored, ...env } = process.env
    // Linha única pela shell (evita o aviso DEP0190 de args + shell:true)
    const child = spawn([cmd, ...args].join(' '), { shell: true, windowsHide: true, env })
    let out = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.on('data', (d) => (out += d))
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
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
  add('App', 'Sistema', 'info', `${platform()} ${release()} (${arch()}) · ${Math.round(totalmem() / 1024 ** 3)} GB RAM`)
  add('App', 'Node.js', nodeMajor >= 20 ? 'ok' : 'fail', `v${process.versions.node}`, nodeMajor >= 20 ? undefined : 'A app precisa de Node 20 ou superior (https://nodejs.org)')
  add('App', 'Servidor', 'info', `http://localhost:${ctx.port} · definições em ${join(dataDir(), 'settings.json')}`)

  // ---- Java ----
  const javaHome = settings.javaHome || process.env.JAVA_HOME
  const javaCmd = settings.javaHome ? `"${join(settings.javaHome, 'bin', 'java')}"` : 'java'
  const java = await tryRun(javaCmd, ['-version'])
  if (!java) add('Java', 'java', 'fail', settings.javaHome ? `não encontrado em ${settings.javaHome}\\bin` : 'não encontrado no PATH', 'Instala um JDK 21 (ex.: Adoptium Temurin) ou define JAVA_HOME em Definições → Java / Maven')
  else {
    const major = javaMajor(java.out)
    const line = java.out.split('\n').find((l) => /version/i.test(l)) ?? java.out.split('\n')[0]
    add('Java', 'java', major === undefined ? 'warn' : major >= 21 ? 'ok' : major >= 17 ? 'warn' : 'fail', line,
      major !== undefined && major < 21 ? 'Spring Boot 3 precisa de Java 17+; o Keycloak 26 precisa de Java 21' : undefined)
  }
  add('Java', 'JAVA_HOME', javaHome ? (existsSync(javaHome) ? 'ok' : 'fail') : 'info', javaHome ?? 'não definido (usa o java do PATH)', javaHome && !existsSync(javaHome) ? 'A pasta não existe' : undefined)

  // ---- Maven / Git ----
  const mvn = await tryRun(settings.mavenCommand || 'mvn', ['-v'])
  const withWrapper = scan?.services.filter((s) => s.wrapperDir).length ?? 0
  const total = scan?.services.length ?? 0
  if (mvn) add('Build', `Maven (${settings.mavenCommand || 'mvn'})`, 'ok', mvn.out.split('\n').find((l) => /Apache Maven/.test(l)) ?? mvn.out.split('\n')[0])
  else add('Build', `Maven (${settings.mavenCommand || 'mvn'})`, total && withWrapper === total ? 'info' : 'warn', 'não encontrado no PATH',
    total && withWrapper === total ? 'Não faz falta: todos os serviços têm mvnw' : 'Instala o Maven ou usa projetos com mvnw.cmd (Definições → preferir wrapper)')
  if (total) add('Build', 'Maven wrapper', withWrapper === total ? 'ok' : withWrapper ? 'warn' : 'info', `${withWrapper} de ${total} serviços têm mvnw`, withWrapper < total && !mvn ? 'Os serviços sem wrapper não vão conseguir arrancar' : undefined)
  const git = await tryRun('git', ['--version'])
  add('Build', 'Git', git ? 'ok' : 'warn', git ? git.out.split('\n')[0] : 'não encontrado no PATH', git ? undefined : 'O separador Git precisa do Git (https://git-scm.com)')

  // ---- Pasta raiz / serviços ----
  if (!settings.rootFolder) add('Serviços', 'Pasta raiz', 'fail', 'não definida', 'Definições → Pasta raiz dos microserviços')
  else if (!existsSync(settings.rootFolder)) add('Serviços', 'Pasta raiz', 'fail', `${settings.rootFolder} não existe`)
  else {
    add('Serviços', 'Pasta raiz', 'ok', settings.rootFolder)
    if (!scan) add('Serviços', 'Scan', 'warn', 'ainda não foi feito', 'Carrega em Rescan')
    else {
      const boots = scan.services.filter((s) => s.kind === 'spring-boot')
      const spis = scan.services.filter((s) => s.kind === 'keycloak-spi')
      add('Serviços', 'Detetados', scan.services.length ? 'ok' : 'warn',
        `${boots.length} Spring Boot · ${spis.length} Keycloak SPI · ${scan.services.length - boots.length - spis.length} outros Maven`,
        scan.services.length ? undefined : 'Nenhum pom.xml encontrado até 6 níveis (target/, node_modules/, src/ são ignorados)')
      const semPorta = boots.filter((s) => !s.configFiles.length)
      if (semPorta.length) add('Serviços', 'Sem application.yml', 'info', semPorta.map((s) => s.name).join(', '), 'Porta assumida 8080; o Swagger/Endpoints podem falhar')
      for (const s of boots) {
        const port = running.get(s.id)?.detectedPort ?? settings.services[s.id]?.port ?? s.port
        if (!port) continue
        const used = await portInUse(port)
        const byApp = running.has(s.id)
        add('Portas', `${s.name} :${port}`, byApp ? 'ok' : used ? 'warn' : 'ok', byApp ? 'a correr (arrancado pela app)' : used ? 'ocupada por outro processo' : 'livre',
          !byApp && used ? 'Se arrancares este serviço vai falhar com "Address already in use" — para o outro processo ou muda server.port' : undefined)
      }
    }
  }

  // ---- Keycloak ----
  const kc = keycloakInfo(settings.keycloak.home)
  if (settings.keycloak.mode === 'container') add('Keycloak', 'Modo', 'info', `container ${settings.keycloak.containerName} · ${settings.keycloak.image}`, 'Precisa do motor de containers (ver secção Containers)')
  else if (!settings.keycloak.home) add('Keycloak', 'Pasta', 'warn', 'não definida', 'Definições → Keycloak (pasta com bin/kc.bat) ou muda para modo container')
  else add('Keycloak', 'Pasta', kc.valid ? 'ok' : 'fail', kc.valid ? `${settings.keycloak.home} · ${kc.version ?? 'versão desconhecida'} · ${kc.providers.length} provider(s)` : `${settings.keycloak.home}: sem bin/kc.${isWin ? 'bat' : 'sh'}`)
  const kcUsed = await portInUse(settings.keycloak.httpPort)
  add('Keycloak', `Porta :${settings.keycloak.httpPort}`, running.has('keycloak') ? 'ok' : kcUsed ? 'warn' : 'info', running.has('keycloak') ? 'Keycloak a correr (arrancado pela app)' : kcUsed ? 'ocupada por outro processo (outro Keycloak?)' : 'livre — Keycloak parado')
  if (settings.keycloak.mode !== 'container' && kc.valid && settings.keycloak.home) {
    const data = join(settings.keycloak.home, 'data')
    add('Keycloak', 'Dados (realms, utilizadores)', existsSync(data) ? 'info' : 'info', existsSync(data) ? `${data} (${statSync(data).isDirectory() ? 'H2 dev' : ''})` : 'ainda sem data/ — primeiro arranque cria o admin com as credenciais das Definições')
  }

  // ---- Containers / Redis ----
  const engine = await engineInfo(settings.containerCommand?.trim() || 'podman')
  if (!engine.available) add('Containers', engine.command, 'warn', engine.error ?? 'não encontrado', 'Instala o Podman (ou Docker e muda o comando em Definições); só afeta as páginas Containers e Redis')
  else {
    const m = engine.machines?.find((x) => x.isDefault) ?? engine.machines?.[0]
    add('Containers', engine.command, engine.error ? 'warn' : 'ok', `cliente ${engine.clientVersion ?? '?'}${engine.serverVersion ? ` · servidor ${engine.serverVersion}` : ''}${m ? ` · máquina ${m.name} ${m.running ? 'a correr' : 'parada'}` : ''}`,
      engine.error ? (m && !m.running ? 'A máquina está parada: Containers → Arrancar máquina' : engine.error) : undefined)
  }
  const redis = await redisOps.info(settings.redis)
  add('Redis', `${settings.redis.host}:${settings.redis.port}`, redis.connected ? 'ok' : 'info', redis.connected ? `v${redis.version} · ${redis.keys} chaves · ${redis.usedMemory}` : redis.error ?? 'sem ligação',
    redis.connected ? undefined : 'Só é preciso se usares a página Redis: arranca lá o container ou ajusta Definições → Redis')

  return { generatedAt: Date.now(), platform: `${platform()} ${arch()}`, items }
}
