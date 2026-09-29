import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, KeycloakInfo, ProcState, ScanResult } from '../../../shared/types'
import { api } from '../api'
import type { LogsApi } from '../hooks'
import { KcAdminPanel } from './KcAdminPanel'
import { LogView } from './LogView'
import { StatusPill, isActive } from './common'

type Tab = 'logs' | 'providers' | 'admin'
const KC_ID = 'keycloak'

export function KeycloakView({
  settings, scan, states, logs, onSaveSettings, pickFolder, notify, fail
}: {
  settings: AppSettings
  scan: ScanResult | null
  states: Record<string, ProcState>
  logs: LogsApi
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings | null>
  pickFolder: (initial?: string) => Promise<string | null>
  notify: (text: string, kind?: 'error' | 'info' | 'success') => void
  fail: (e: unknown) => void
}) {
  const [tab, setTab] = useState<Tab>('logs')
  const [info, setInfo] = useState<KeycloakInfo | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const state = states[KC_ID]
  const kc = settings.keycloak
  const container = kc.mode === 'container'
  // modo container: o estado é o do container (o processo "keycloak" da app é só o podman logs -f)
  const active = container ? !!info?.container?.running || isActive(state) : isActive(state)
  const running = container ? !!info?.container?.running : state?.status === 'running' && state.mode === 'run'
  const adminUrl = `http://localhost:${kc.httpPort}/admin/`

  const refreshInfo = useCallback(() => api.kcInfo().then(setInfo).catch(fail), [fail])
  const loadLogs = logs.load
  useEffect(() => {
    void refreshInfo()
    void loadLogs(KC_ID)
  }, [kc.home, kc.mode, kc.containerName, refreshInfo, loadLogs])
  useEffect(() => {
    if (!active) void refreshInfo() // depois de build/deploy a lista de providers pode ter mudado
  }, [active, refreshInfo])
  useEffect(() => {
    if (!container) return
    const t = setInterval(() => void refreshInfo(), 5000)
    return () => clearInterval(t)
  }, [container, refreshInfo])

  const run = async (label: string, fn: () => Promise<unknown>, after?: () => void): Promise<void> => {
    setBusy(label)
    try {
      await fn()
      after?.()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const pickHome = async (): Promise<void> => {
    const dir = await pickFolder(kc.home)
    if (dir) await onSaveSettings({ keycloak: { ...kc, home: dir } })
  }

  const spis = scan?.services.filter((s) => s.kind === 'keycloak-spi') ?? []

  const installAll = (): Promise<void> => run('deploy-all', async () => {
    for (const s of spis) await api.kcDeploySpi(s.id)
    await api.kcRestart()
  }, () => {
    void refreshInfo()
    notify(`${spis.length} SPI(s) instalados; Keycloak a reiniciar`, 'success')
  })

  return (
    <main className="service">
      <div className="svc-header">
        <div className="grow">
          <h2>Keycloak {info?.version && <span className="muted small">{info.version}</span>}</h2>
          <div className="muted mono small">
            {container ? (
              <>
                🐳 container <b>{kc.containerName}</b> · {kc.image}
                {info?.container && <> · {info.container.running ? 'a correr' : info.container.exists ? `parado (${info.container.status ?? ''})` : 'ainda não criado'}</>}
                {info?.engineError && <span className="text-error"> · {info.engineError}</span>}
              </>
            ) : kc.home ? (
              <a className="link" onClick={() => api.openPath(kc.home!)}>{kc.home}</a>
            ) : (
              'pasta não definida'
            )}
            {info && !container && kc.home && !info.valid && <span className="text-error"> — bin/kc.bat não encontrado</span>}
            {' '}· porta {kc.httpPort} · admin <b>{kc.adminUser}</b>
          </div>
        </div>
        <StatusPill state={state} port={kc.httpPort} />
      </div>

      <div className="actions">
        {!running && (
          <button className="btn btn-primary" disabled={!info?.valid || !!busy} onClick={() => run('start', api.kcStart, () => void refreshInfo())} title={container ? `${kc.image} start-dev (a primeira vez faz pull da imagem)` : 'kc start-dev'}>
            {busy === 'start' ? 'A arrancar…' : container ? '▶ Arrancar container' : '▶ Arrancar (start-dev)'}
          </button>
        )}
        {running && <button className="btn btn-danger" disabled={!!busy || state?.status === 'stopping'} onClick={() => run('stop', api.kcStop, () => void refreshInfo())}>{busy === 'stop' ? 'A parar…' : '■ Parar'}</button>}
        <button className="btn" disabled={!info?.valid || !!busy || state?.status === 'stopping'} onClick={() => run('restart', api.kcRestart, () => void refreshInfo())}>⟳ Reiniciar</button>
        {!container && <button className="btn" disabled={!info?.valid || active || !!busy} onClick={() => run('build', api.kcBuild)} title="kc.bat build — necessário depois de mudar providers em modo produção">Build</button>}
        {container && (
          <button className="btn" disabled={!info?.valid || !!busy} title="Apaga e cria de novo o container com a imagem/pastas/porta atuais das Definições (os dados ficam no disco)"
            onClick={() => { if (confirm(`Recriar o container ${kc.containerName}? Os dados (H2) e providers ficam no disco.`)) void run('recreate', api.kcRecreate, () => void refreshInfo()) }}>Recriar container</button>
        )}
        <span className="grow" />
        <button className="btn" onClick={() => api.openExternal(adminUrl)} title={adminUrl}>Consola de administração</button>
        {!container && <button className="btn" onClick={pickHome}>Escolher pasta…</button>}
        {!container && scan?.keycloakHome && scan.keycloakHome !== kc.home && (
          <button className="btn" onClick={() => onSaveSettings({ keycloak: { ...kc, home: scan.keycloakHome } })} title={scan.keycloakHome}>
            Usar a detetada no scan
          </button>
        )}
      </div>
      {container && info?.keycloakContainers && info.keycloakContainers.filter((c) => c.name !== kc.containerName).length > 0 && (
        <div className="actions">
          <span className="muted small">Outros containers Keycloak encontrados:</span>
          {info.keycloakContainers.filter((c) => c.name !== kc.containerName).map((c) => (
            <span key={c.name} className="row" style={{ gap: 6 }}>
              <span className="mono small">{c.name} <span className="muted">({c.image}, {c.state})</span></span>
              <button className="btn btn-sm" disabled={!!busy} onClick={() => onSaveSettings({ keycloak: { ...kc, containerName: c.name } })} title="Passar a gerir este container (os providers/dados são os dele)">Usar este</button>
            </span>
          ))}
        </div>
      )}

      <div className="tabs">
        <button className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>Logs</button>
        <button className={tab === 'providers' ? 'active' : ''} onClick={() => setTab('providers')}>
          Providers / SPIs {info?.providers.length ? <span className="count">{info.providers.length}</span> : null}
        </button>
        <button className={tab === 'admin' ? 'active' : ''} onClick={() => setTab('admin')}>Administração</button>
      </div>

      <div className="tab-body">
        {tab === 'logs' && <LogView lines={logs.get(KC_ID)} version={logs.version} onClear={() => logs.clear(KC_ID)} />}

        {tab === 'providers' && (
          <div className="config">
            <section>
              <h3>Instalados em <span className="mono">{container ? info?.providersDir : 'providers/'}</span>{container && <span className="muted"> (montada em /opt/keycloak/providers)</span>}</h3>
              {!info?.providers.length && <p className="muted">Nenhum provider instalado.</p>}
              {info?.providers.map((p) => (
                <div className="row" key={p}>
                  <span className="mono grow">{p}</span>
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={!!busy}
                    onClick={() => {
                      if (confirm(`Remover ${p} de providers/?`)) void run('remove', () => api.kcRemoveProvider(p), () => void refreshInfo())
                    }}
                  >
                    Remover
                  </button>
                </div>
              ))}
              {active && <p className="muted small">Alterações em providers/ só são carregadas depois de reiniciar o Keycloak.</p>}
            </section>
            <section>
              <div className="row">
                <h3 className="grow">Projetos SPI encontrados no scan</h3>
                {spis.length > 1 && <button className="btn btn-sm btn-primary" disabled={!info?.valid || !!busy} onClick={installAll} title="Build + copiar cada jar para providers, e reiniciar o Keycloak no fim">{busy === 'deploy-all' ? 'A instalar…' : `⇪ Instalar todos (${spis.length}) e reiniciar`}</button>}
              </div>
              {!spis.length && <p className="muted">Nenhum projeto com dependências org.keycloak encontrado.</p>}
              {spis.map((s) => (
                <div className="row" key={s.id}>
                  <div className="grow">
                    <div>{s.name} <span className="muted small mono">{s.relativePath}</span></div>
                    <div className="muted small mono">{s.spiProviders.map((p) => p.split('.').pop()).join(', ') || 'sem META-INF/services'}</div>
                  </div>
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={!info?.valid || !!busy || isActive(states[s.id])}
                    onClick={() =>
                      run(`deploy:${s.id}`, () => api.kcDeploySpi(s.id), () => {
                        void refreshInfo()
                        notify(active ? 'Provider instalado. Reinicia o Keycloak para o carregar.' : 'Provider instalado.', 'success')
                      })
                    }
                  >
                    {busy === `deploy:${s.id}` ? 'A compilar…' : 'Build & instalar'}
                  </button>
                </div>
              ))}
            </section>
          </div>
        )}

        {tab === 'admin' && <KcAdminPanel running={running} fail={fail} notify={notify} />}
      </div>
    </main>
  )
}
