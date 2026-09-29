import { useEffect, useState } from 'react'
import { BUILD_MODES, type AppSettings, type ProcState, type ServiceInfo, type ServiceSettings, type StartMode } from '../../../shared/types'
import { api } from '../api'
import type { LogsApi } from '../hooks'
import { ConfigView } from './ConfigView'
import { EndpointsView } from './EndpointsView'
import { EnvsView } from './EnvsView'
import { GitView } from './GitView'
import { DepsView } from './DepsView'
import { LogView } from './LogView'
import { SwaggerView } from './SwaggerView'
import { Badge, StatusPill, isActive } from './common'

type Tab = 'logs' | 'endpoints' | 'swagger' | 'envs' | 'deps' | 'git' | 'config'

export function ServiceView({
  svc, state, states, settings, logs, onStart, onStop, onSaveServiceSettings, onSettingsChanged, onGitChanged, notify, fail
}: {
  svc: ServiceInfo
  state?: ProcState
  states: Record<string, ProcState>
  settings: AppSettings
  logs: LogsApi
  onStart: (id: string, mode: StartMode) => Promise<void>
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
  const port = state?.detectedPort ?? ss.port ?? svc.port ?? 8080
  const baseUrl = `http://localhost:${port}${svc.contextPath ?? ''}`
  const swaggerUrl = baseUrl + (ss.swaggerPath || svc.swaggerPath || '/swagger-ui/index.html')
  const debugPort = ss.debugPort || defaultDebugPort
  // Ficheiros de configuração que o Spring vai carregar com o perfil definido em Configuração
  const profiles = (ss.profile ?? '').split(',').map((p) => p.trim()).filter(Boolean)
  const configFiles = ['application.yml', ...profiles.map((p) => `application-${p}.yml`)].join(' + ')
  const profileLabel = profiles.length ? ` · ${profiles.join(',')}` : ''

  const deploy = async (build: boolean): Promise<void> => {
    setDeploying(true)
    try {
      const r = await api.kcDeploySpi(svc.id, { build, restart: true })
      notify(`${build ? 'Compilado e copiado' : 'Jar copiado'} para ${r.dest.split(/[\\/]/).pop()}; Keycloak reiniciado`, 'success')
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
        {svc.kind === 'spring-boot' && !active && (
          <>
            <label className={`switch${ss.debug ? ' on' : ''}`} title={`Quando ligado, "Arrancar" (e "Arrancar todos") usa JDWP em localhost:${debugPort}, pronto para attach do IDE`}>
              <input type="checkbox" checked={!!ss.debug} onChange={(e) => onSaveServiceSettings(svc.id, { ...ss, debug: e.target.checked }, true)} />
              <span className="switch-track"><span className="switch-knob" /></span>
              <span className="switch-label">🐞 Debug :{debugPort}</span>
            </label>
            <button className="btn btn-primary" onClick={() => onStart(svc.id, ss.debug ? 'debug' : 'run')} title={`Carrega ${configFiles}${profiles.length ? '' : ' (sem perfil: define-o em Configuração ou Ambientes)'}${ss.debug ? ` · JDWP em localhost:${debugPort} (suspend=n)` : ''}`}>
              ▶ Arrancar{profileLabel}{ss.port ? ` · :${ss.port}` : ''}{ss.debug ? ' 🐞' : ''}
            </button>
          </>
        )}
        {active && (
          <button className="btn btn-danger" disabled={state?.status === 'stopping'} onClick={() => onStop(svc.id)}>■ Parar</button>
        )}
        {svc.kind === 'keycloak-spi' && (
          <>
            <button className="btn btn-primary" disabled={active || deploying} onClick={() => deploy(true)} title="mvn package + copiar o jar para providers + reiniciar o Keycloak">
              {deploying ? 'A instalar…' : '⇪ Build & instalar'}
            </button>
            <button className="btn" disabled={active || deploying || !svc.jarPath} onClick={() => deploy(false)} title={svc.jarPath ? `copiar ${svc.jarPath.split(/[\\/]/).pop()} (já compilado, ex. no IntelliJ) para providers + reiniciar` : 'sem jar em target/ — compila primeiro'}>
              ⇪ Instalar jar existente
            </button>
          </>
        )}
      </div>
      <div className="actions actions-secondary">
        <button className="btn" disabled={active} onClick={() => onStart(svc.id, 'build')} title="mvn -DskipTests package">Build</button>
        <button className="btn" disabled={active} onClick={() => onStart(svc.id, 'clean-build')} title="mvn clean -DskipTests package">Clean build</button>
        <button className="btn" disabled={active} onClick={() => onStart(svc.id, 'clean-install')} title="mvn clean -DskipTests install (instala no repositório local ~/.m2)">Clean install</button>
        {svc.kind === 'spring-boot' && (
          <>
            <button className="btn" onClick={() => setTab('endpoints')}>Endpoints</button>
            <button className="btn" disabled={!running} onClick={() => setTab('swagger')}>Swagger</button>
            <button className="btn" disabled={!running} onClick={() => api.openExternal(baseUrl)} title={baseUrl}>Abrir URL</button>
          </>
        )}
        <button className="btn" onClick={() => api.openPath(svc.path)}>Pasta</button>
      </div>

      <div className="tabs">
        <button className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>Logs</button>
        {svc.kind === 'spring-boot' && <button className={tab === 'endpoints' ? 'active' : ''} onClick={() => setTab('endpoints')}>Endpoints</button>}
        {svc.kind === 'spring-boot' && <button className={tab === 'swagger' ? 'active' : ''} onClick={() => setTab('swagger')}>Swagger</button>}
        {svc.kind === 'spring-boot' && <button className={tab === 'envs' ? 'active' : ''} onClick={() => setTab('envs')}>Ambientes{svc.profiles.length ? <span className="count">{svc.profiles.length}</span> : null}</button>}
        <button className={tab === 'deps' ? 'active' : ''} onClick={() => setTab('deps')}>Dependências</button>
        <button className={tab === 'git' ? 'active' : ''} onClick={() => setTab('git')}>Git</button>
        <button className={tab === 'config' ? 'active' : ''} onClick={() => setTab('config')}>Configuração</button>
      </div>

      <div className="tab-body">
        {tab === 'logs' && <LogView lines={logs.get(svc.id)} version={logs.version} onClear={() => logs.clear(svc.id)} />}
        {tab === 'endpoints' && <EndpointsView svc={svc} baseUrl={baseUrl} running={running} kcPort={settings.keycloak.httpPort} notify={notify} />}
        {tab === 'swagger' && <SwaggerView url={swaggerUrl} running={running} />}
        {tab === 'envs' && <EnvsView svc={svc} settings={ss} notify={notify} fail={fail} onChanged={onSettingsChanged} onSetProfile={(p) => onSaveServiceSettings(svc.id, { ...ss, profile: p }, true)} />}
        {tab === 'deps' && <DepsView svc={svc} logs={logs} states={states} fail={fail} />}
        {tab === 'git' && <GitView svc={svc} notify={notify} fail={fail} onChanged={onGitChanged} />}
        {tab === 'config' && (
          <ConfigView svc={svc} settings={ss} defaultDebugPort={defaultDebugPort} onSave={(next) => onSaveServiceSettings(svc.id, next)} />
        )}
      </div>
    </main>
  )
}
