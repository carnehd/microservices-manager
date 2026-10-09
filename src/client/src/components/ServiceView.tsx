import { useEffect, useState } from 'react'
import { BUILD_MODES, type AppSettings, type GitSummary, type ProcState, type ServiceInfo, type ServiceSettings, type StartMode } from '../../../shared/types'
import { api } from '../api'
import { icons } from '../assets/icons'
import type { LogsApi } from '../hooks'
import { ConfigView } from './ConfigView'
import { BrunoView } from './BrunoView'
import { EnvsView } from './EnvsView'
import { JarsView } from './JarsView'
import { GitView } from './GitView'
import { DepsView } from './DepsView'
import { SrDatabaseView } from './SrDatabaseView'
import { LogView } from './LogView'
import { STATUS_LABEL, StatusDot, isActive } from './common'

type Tab = 'logs' | 'bruno' | 'envs' | 'jars' | 'deps' | 'srdb' | 'git' | 'config'

export function ServiceView({
  svc, state, states, settings, git, logs, onStart, onStartWithDeps, onStop, onSaveServiceSettings, onSettingsChanged, onGitChanged, onBreadcrumb, notify, fail
}: {
  svc: ServiceInfo
  state?: ProcState
  states: Record<string, ProcState>
  settings: AppSettings
  git?: GitSummary[string]
  logs: LogsApi
  onStart: (id: string, mode: StartMode) => Promise<void>
  onStartWithDeps: (id: string, mode: StartMode) => Promise<void>
  onStop: (id: string) => Promise<void>
  onSaveServiceSettings: (id: string, ss: ServiceSettings, quiet?: boolean) => Promise<void>
  onSettingsChanged: () => Promise<void>
  onGitChanged: () => Promise<void>
  /** "Services" no breadcrumb: volta à lista */
  onBreadcrumb?: () => void
  notify: (text: string, kind?: 'error' | 'info' | 'success') => void
  fail: (e: unknown) => void
}) {
  const [tab, setTab] = useState<Tab>('logs')
  const [deploying, setDeploying] = useState(false)
  const [defaultDebugPort, setDefaultDebugPort] = useState<number>(settings.baseDebugPort)

  const loadLogs = logs.load
  useEffect(() => {
    void loadLogs(svc.id)
    if (svc.kind === 'spring-boot') api.defaultDebugPort(svc.id).then(setDefaultDebugPort).catch(() => {})
  }, [svc.id, svc.kind, loadLogs])

  const ss = settings.services[svc.id] ?? {}
  const active = isActive(state)
  const running = state?.status === 'running' && !!state.mode && !BUILD_MODES.has(state.mode)
  const building = active && !!state?.mode && BUILD_MODES.has(state.mode)
  const runStarting = state?.status === 'starting' && !building
  const stopping = state?.status === 'stopping'
  const deps = (ss.dependsOn && ss.dependsOn.length ? ss.dependsOn : svc.dependsOn) ?? []
  const debugPort = ss.debugPort || defaultDebugPort
  // Ficheiros de configuração que o Spring vai carregar com o perfil definido em Configuração
  const profiles = (ss.profile ?? '').split(',').map((p) => p.trim()).filter(Boolean)
  const configFiles = ['application.yml', ...profiles.map((p) => `application-${p}.yml`)].join(' + ')
  const profileLabel = profiles.length ? ` · ${profiles.join(',')}` : ''
  const port = state?.detectedPort ?? ss.port ?? svc.port
  const changes = git?.changes ?? 0

  const deploy = async (build: boolean): Promise<void> => {
    setDeploying(true)
    try {
      const r = await api.kcDeploySpi(svc.id, { build, restart: true })
      notify(`${build ? 'Compiled and copied' : 'Jar copied'} to ${r.dest.split(/[\\/]/).pop()}; Keycloak restarted`, 'success')
    } catch (e) {
      fail(e)
    } finally {
      setDeploying(false)
    }
  }

  return (
    <main className="service">
      {/* Cabeçalho do serviço (maquete "Service overview"): breadcrumb, identidade + arranque, opções + build, tabs */}
      <div className="svc-hero">
        <div className="svc-crumb">
          <button type="button" className="link" onClick={onBreadcrumb}>Services</button>
          <img src={icons.chevronRight} alt="" width={12} height={12} />
          <span>{svc.name}</span>
        </div>

        <div className="svc-identity-row">
          <div className="svc-identity">
            <div className="svc-title-row">
              <h2 className="svc-title">{svc.name}</h2>
              {svc.version && <span className="version-pill" title={`${svc.groupId ?? ''}:${svc.artifactId}:${svc.version}`}>{svc.version}</span>}
            </div>
            <div className="svc-meta">
              <span className="svc-meta-item"><StatusDot status={state?.status} /> {STATUS_LABEL[state?.status ?? 'stopped']}{active && port ? ` · :${port}` : ''}</span>
              {git?.branch && <span className="svc-meta-item"><img src={icons.gitBranch13} alt="" width={13} height={13} /> {git.branch}</span>}
              {git && <span className="svc-meta-item">{changes ? `${changes} change${changes === 1 ? '' : 's'}` : 'No changes'}</span>}
            </div>
          </div>
          <div className="svc-run">
            {svc.kind === 'spring-boot' && !active && (
              <button className="btn btn-primary btn-lg" onClick={() => onStart(svc.id, ss.debug ? 'debug' : 'run')} title={`Loads ${configFiles}${profiles.length ? '' : ' (no profile: set it in Configuration or Environments)'}${ss.debug ? ` · JDWP on localhost:${debugPort} (suspend=n)` : ''}`}>
                <img src={icons.play} alt="" width={15} height={15} />Start{profileLabel}{ss.port ? ` · :${ss.port}` : ''}
              </button>
            )}
            {svc.kind === 'spring-boot' && runStarting && <button className="btn btn-primary btn-lg" disabled>starting…</button>}
            {active && !runStarting && (
              <button className="btn btn-danger btn-lg" disabled={stopping} onClick={() => onStop(svc.id)}>{stopping ? 'stopping…' : '■ Stop'}</button>
            )}
            {svc.kind === 'spring-boot' && !active && deps.length > 0 && (
              <button className="btn btn-lg" onClick={() => onStartWithDeps(svc.id, ss.debug ? 'debug' : 'run')} title={`Starts first the dependencies (${deps.join(', ')}) that aren't running, then this service`}>
                <img src={icons.play} alt="" width={15} height={15} />+ dependencies ({deps.length})
              </button>
            )}
            {svc.kind === 'spring-boot' && !active && (
              <button className="btn btn-lg" onClick={() => onStart(svc.id, ss.debug ? 'container-debug' : 'container')}
                title={`mvn package, then run the jar in a container (Settings → Java image; target/ mounted at /app; port ${ss.port ?? svc.port ?? 8080} published${ss.debug ? `; JDWP on localhost:${debugPort}` : ''}). Inside the container "localhost" is the container itself — point to the host with host.containers.internal (env vars in Configuration).`}>
                🐳 Container{ss.debug ? ' · debug' : ''}
              </button>
            )}
            {svc.kind === 'spring-boot' && (
              <button type="button" className="btn btn-lg btn-icon" onClick={() => setTab('config')} title="Configuration — environment variables (passed with -e to the container), profile, port, JVM args" aria-label="Configuration">
                <img src={icons.pencil} alt="" width={14} height={14} />
              </button>
            )}
            {svc.kind === 'keycloak-spi' && (
              <>
                <button className="btn btn-primary btn-lg" disabled={active || deploying} onClick={() => deploy(true)} title="mvn package + copy the jar to providers + restart Keycloak">
                  {deploying ? 'Installing…' : '⇪ Build & install'}
                </button>
                <button className="btn btn-lg" disabled={active || deploying || !svc.jarPath} onClick={() => deploy(false)} title={svc.jarPath ? `copy ${svc.jarPath.split(/[\\/]/).pop()} (already compiled, e.g. in IntelliJ) to providers + restart` : 'no jar in target/ — build first'}>
                  ⇪ Install existing jar
                </button>
              </>
            )}
            <button className="btn btn-lg" onClick={() => api.openPath(svc.path)}><img src={icons.folder} alt="" width={15} height={15} />Folder</button>
          </div>
        </div>

        <div className="svc-options-row">
          <div className="svc-options">
            {svc.kind === 'spring-boot' && (
              <>
                <label className={`switch${ss.debug ? ' on' : ''}${active ? ' disabled' : ''}`} title={`When on, "Start" (and "Start all") uses JDWP on localhost:${debugPort}, ready for IDE attach`}>
                  <input type="checkbox" checked={!!ss.debug} disabled={active} onChange={(e) => onSaveServiceSettings(svc.id, { ...ss, debug: e.target.checked }, true)} />
                  <span className="switch-track"><span className="switch-knob" /></span>
                  <span className="switch-label">Debug :{debugPort}</span>
                </label>
                <label className={`switch${ss.skipTests === false ? '' : ' on'}${active ? ' disabled' : ''}`} title="When on, Build/Clean build/Clean install run with -DskipTests (tests are not run)">
                  <input type="checkbox" checked={ss.skipTests !== false} disabled={active} onChange={(e) => onSaveServiceSettings(svc.id, { ...ss, skipTests: e.target.checked }, true)} />
                  <span className="switch-track"><span className="switch-knob" /></span>
                  <span className="switch-label">Skip tests</span>
                </label>
                <label className={`switch${ss.spotless ? ' on' : ''}${active ? ' disabled' : ''}`} title="When on, runs spotless:apply (formats the code) before builds and startup">
                  <input type="checkbox" checked={!!ss.spotless} disabled={active} onChange={(e) => onSaveServiceSettings(svc.id, { ...ss, spotless: e.target.checked }, true)} />
                  <span className="switch-track"><span className="switch-knob" /></span>
                  <span className="switch-label">Spotless</span>
                </label>
              </>
            )}
          </div>
          <div className="svc-build">
            <button className="btn" disabled={active} onClick={() => onStart(svc.id, 'build')} title={`mvn ${ss.skipTests === false ? '' : '-DskipTests '}package`}>Build</button>
            <button className="btn" disabled={active} onClick={() => onStart(svc.id, 'clean-build')} title={`mvn clean ${ss.skipTests === false ? '' : '-DskipTests '}package`}>Clean build</button>
            <button className="btn" disabled={active} onClick={() => onStart(svc.id, 'clean-install')} title={`mvn clean ${ss.skipTests === false ? '' : '-DskipTests '}install (installs to the local repository ~/.m2)`}>Clean install</button>
            <button className="btn" disabled={active} onClick={() => onStart(svc.id, 'spotless')} title="mvn spotless:apply — formats the code according to the project rules">Spotless</button>
          </div>
        </div>

        <div className="tabs svc-tabs">
          <button className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>Logs</button>
          {svc.kind === 'spring-boot' && <button className={tab === 'envs' ? 'active' : ''} onClick={() => setTab('envs')}>Environments{svc.profiles.length ? <span className="count">{svc.profiles.length}</span> : null}</button>}
          {svc.srDatabase && <button className={tab === 'srdb' ? 'active' : ''} onClick={() => setTab('srdb')}>Database</button>}
          {(svc.brunoCollections?.length ?? 0) > 0 && <button className={tab === 'bruno' ? 'active' : ''} onClick={() => setTab('bruno')}>Bruno<span className="count">{svc.brunoCollections!.length}</span></button>}
          {svc.kind === 'keycloak-spi' && <button className={tab === 'jars' ? 'active' : ''} onClick={() => setTab('jars')}>Jars</button>}
          <button className={tab === 'deps' ? 'active' : ''} onClick={() => setTab('deps')}>Dependencies</button>
          <button className={tab === 'git' ? 'active' : ''} onClick={() => setTab('git')}>Git</button>
          <button className={tab === 'config' ? 'active' : ''} onClick={() => setTab('config')}>Configuration</button>
        </div>
      </div>

      <div className="tab-body">
        {tab === 'logs' && <LogView lines={logs.get(svc.id)} version={logs.version} onClear={() => logs.clear(svc.id)} />}
        {tab === 'bruno' && <BrunoView svc={svc} kcPort={settings.keycloak.httpPort} notify={notify} fail={fail} />}
        {tab === 'jars' && <JarsView svc={svc} notify={notify} fail={fail} />}
        {tab === 'envs' && <EnvsView svc={svc} settings={ss} notify={notify} fail={fail} onChanged={onSettingsChanged} onSetProfile={async (p) => { await api.setEnvProfile(svc.id, p); await onSettingsChanged() }} />}
        {tab === 'deps' && <DepsView svc={svc} logs={logs} states={states} fail={fail} />}
        {tab === 'srdb' && <SrDatabaseView svc={svc} settings={settings} running={running} notify={notify} fail={fail} onSettingsChanged={onSettingsChanged} />}
        {tab === 'git' && <GitView svc={svc} notify={notify} fail={fail} onChanged={onGitChanged} />}
        {tab === 'config' && (
          <ConfigView svc={svc} settings={ss} defaultDebugPort={defaultDebugPort} onSave={(next) => onSaveServiceSettings(svc.id, next)} />
        )}
      </div>
    </main>
  )
}
