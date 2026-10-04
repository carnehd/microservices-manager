import { useEffect, useState } from 'react'
import { BUILD_MODES, type AppSettings, type ProcState, type ServiceInfo, type ServiceSettings, type StartMode } from '../../../shared/types'
import { api } from '../api'
import type { LogsApi } from '../hooks'
import { ConfigView } from './ConfigView'
import { BrunoView } from './BrunoView'
import { EnvsView } from './EnvsView'
import { JarsView } from './JarsView'
import { GitView } from './GitView'
import { DepsView } from './DepsView'
import { SrDatabaseView } from './SrDatabaseView'
import { LogView } from './LogView'
import { Badge, StatusPill, isActive } from './common'

type Tab = 'logs' | 'bruno' | 'envs' | 'jars' | 'deps' | 'srdb' | 'git' | 'config'

export function ServiceView({
  svc, state, states, settings, logs, onStart, onStartWithDeps, onStop, onSaveServiceSettings, onSettingsChanged, onGitChanged, notify, fail
}: {
  svc: ServiceInfo
  state?: ProcState
  states: Record<string, ProcState>
  settings: AppSettings
  logs: LogsApi
  onStart: (id: string, mode: StartMode) => Promise<void>
  onStartWithDeps: (id: string, mode: StartMode) => Promise<void>
  onStop: (id: string) => Promise<void>
  onSaveServiceSettings: (id: string, ss: ServiceSettings, quiet?: boolean) => Promise<void>
  onSettingsChanged: () => Promise<void>
  onGitChanged: () => Promise<void>
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
      <div className="svc-header">
        <div className="grow">
          <h2>
            {svc.name}
            {svc.version && <Badge tone="green" title={`${svc.groupId ?? ''}:${svc.artifactId}:${svc.version}`}>{svc.version}</Badge>}
          </h2>
        </div>
        <StatusPill state={state} port={ss.port ?? svc.port} />
      </div>

      <div className="actions">
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
              <span className="switch-label">skip tests</span>
            </label>
            <label className={`switch${ss.spotless ? ' on' : ''}${active ? ' disabled' : ''}`} title="When on, runs spotless:apply (formats the code) before builds and startup">
              <input type="checkbox" checked={!!ss.spotless} disabled={active} onChange={(e) => onSaveServiceSettings(svc.id, { ...ss, spotless: e.target.checked }, true)} />
              <span className="switch-track"><span className="switch-knob" /></span>
              <span className="switch-label">spotless</span>
            </label>
            {!active && (
              <button className="btn btn-primary" onClick={() => onStart(svc.id, ss.debug ? 'debug' : 'run')} title={`Loads ${configFiles}${profiles.length ? '' : ' (no profile: set it in Configuration or Environments)'}${ss.debug ? ` · JDWP on localhost:${debugPort} (suspend=n)` : ''}`}>
                ▶ Start{profileLabel}{ss.port ? ` · :${ss.port}` : ''}
              </button>
            )}
            {runStarting && <button className="btn btn-primary" disabled>starting…</button>}
            {active && !runStarting && (
              <button className="btn btn-danger" disabled={stopping} onClick={() => onStop(svc.id)}>{stopping ? 'stopping…' : '■ Stop'}</button>
            )}
            {!active && deps.length > 0 && (
              <button className="btn" onClick={() => onStartWithDeps(svc.id, ss.debug ? 'debug' : 'run')} title={`Starts first the dependencies (${deps.join(', ')}) that aren't running, then this service`}>
                ▶ + dependencies ({deps.length})
              </button>
            )}
          </>
        )}
        {active && svc.kind !== 'spring-boot' && (
          <button className="btn btn-danger" disabled={stopping} onClick={() => onStop(svc.id)}>{stopping ? 'stopping…' : '■ Stop'}</button>
        )}
        {svc.kind === 'keycloak-spi' && (
          <>
            <button className="btn btn-primary" disabled={active || deploying} onClick={() => deploy(true)} title="mvn package + copy the jar to providers + restart Keycloak">
              {deploying ? 'Installing…' : '⇪ Build & install'}
            </button>
            <button className="btn" disabled={active || deploying || !svc.jarPath} onClick={() => deploy(false)} title={svc.jarPath ? `copy ${svc.jarPath.split(/[\\/]/).pop()} (already compiled, e.g. in IntelliJ) to providers + restart` : 'no jar in target/ — build first'}>
              ⇪ Install existing jar
            </button>
          </>
        )}
      </div>
      <div className="actions actions-secondary">
        <button className="btn" disabled={active} onClick={() => onStart(svc.id, 'build')} title={`mvn ${ss.skipTests === false ? "" : "-DskipTests "}package`}>Build</button>
        <button className="btn" disabled={active} onClick={() => onStart(svc.id, 'clean-build')} title={`mvn clean ${ss.skipTests === false ? "" : "-DskipTests "}package`}>Clean build</button>
        <button className="btn" disabled={active} onClick={() => onStart(svc.id, 'clean-install')} title={`mvn clean ${ss.skipTests === false ? '' : '-DskipTests '}install (installs to the local repository ~/.m2)`}>Clean install</button>
        <button className="btn" disabled={active} onClick={() => onStart(svc.id, 'spotless')} title="mvn spotless:apply — formats the code according to the project rules">Spotless</button>
        <span className="grow" />
        <button className="btn" onClick={() => api.openPath(svc.path)}>Folder</button>
      </div>

      <div className="tabs">
        <button className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>Logs</button>
        {(svc.brunoCollections?.length ?? 0) > 0 && <button className={tab === 'bruno' ? 'active' : ''} onClick={() => setTab('bruno')}>Bruno<span className="count">{svc.brunoCollections!.length}</span></button>}
        {svc.kind === 'keycloak-spi' && <button className={tab === 'jars' ? 'active' : ''} onClick={() => setTab('jars')}>Jars</button>}
        {svc.kind === 'spring-boot' && <button className={tab === 'envs' ? 'active' : ''} onClick={() => setTab('envs')}>Environments{svc.profiles.length ? <span className="count">{svc.profiles.length}</span> : null}</button>}
        <button className={tab === 'deps' ? 'active' : ''} onClick={() => setTab('deps')}>Dependencies</button>
        {svc.srDatabase && <button className={tab === 'srdb' ? 'active' : ''} onClick={() => setTab('srdb')}>Database</button>}
        <button className={tab === 'git' ? 'active' : ''} onClick={() => setTab('git')}>Git</button>
        <button className={tab === 'config' ? 'active' : ''} onClick={() => setTab('config')}>Configuration</button>
      </div>

      <div className="tab-body">
        {tab === 'logs' && <LogView lines={logs.get(svc.id)} version={logs.version} onClear={() => logs.clear(svc.id)} />}
        {tab === 'bruno' && <BrunoView svc={svc} kcPort={settings.keycloak.httpPort} notify={notify} fail={fail} />}
        {tab === 'jars' && <JarsView svc={svc} notify={notify} fail={fail} />}
        {tab === 'envs' && <EnvsView svc={svc} settings={ss} notify={notify} fail={fail} onChanged={onSettingsChanged} onSetProfile={async (p) => { await api.setEnvProfile(svc.id, p); await onSettingsChanged() }} />}
        {tab === 'deps' && <DepsView svc={svc} logs={logs} states={states} fail={fail} />}
        {tab === 'srdb' && <SrDatabaseView svc={svc} settings={settings} running={running} notify={notify} fail={fail} />}
        {tab === 'git' && <GitView svc={svc} notify={notify} fail={fail} onChanged={onGitChanged} />}
        {tab === 'config' && (
          <ConfigView svc={svc} settings={ss} defaultDebugPort={defaultDebugPort} onSave={(next) => onSaveServiceSettings(svc.id, next)} />
        )}
      </div>
    </main>
  )
}
