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
  const active = isActive(state)
  const running = state?.status === 'running' && state.mode === 'run'
  const kc = settings.keycloak
  const adminUrl = `http://localhost:${kc.httpPort}/admin/`

  const refreshInfo = useCallback(() => api.kcInfo().then(setInfo).catch(fail), [fail])
  const loadLogs = logs.load
  useEffect(() => {
    void refreshInfo()
    void loadLogs(KC_ID)
  }, [kc.home, refreshInfo, loadLogs])
  useEffect(() => {
    if (!active) void refreshInfo() // depois de build/deploy a lista de providers pode ter mudado
  }, [active, refreshInfo])

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

  return (
    <main className="service">
      <div className="svc-header">
        <div className="grow">
          <h2>Keycloak {info?.version && <span className="muted small">{info.version}</span>}</h2>
          <div className="muted mono small">
            {kc.home ? (
              <a className="link" onClick={() => api.openPath(kc.home!)}>{kc.home}</a>
            ) : (
              'pasta não definida'
            )}
            {info && kc.home && !info.valid && <span className="text-error"> — bin/kc.bat não encontrado</span>}
            {' '}· porta {kc.httpPort} · admin <b>{kc.adminUser}</b>
          </div>
        </div>
        <StatusPill state={state} port={kc.httpPort} />
      </div>

      <div className="actions">
        {!active && <button className="btn btn-primary" disabled={!info?.valid || !!busy} onClick={() => run('start', api.kcStart)}>▶ Arrancar (start-dev)</button>}
        {active && <button className="btn btn-danger" disabled={state?.status === 'stopping'} onClick={() => run('stop', () => api.stop(KC_ID))}>■ Parar</button>}
        <button className="btn" disabled={!info?.valid || !!busy || state?.status === 'stopping'} onClick={() => run('restart', api.kcRestart)}>⟳ Reiniciar</button>
        <button className="btn" disabled={!info?.valid || active || !!busy} onClick={() => run('build', api.kcBuild)} title="kc.bat build — necessário depois de mudar providers em modo produção">Build</button>
        <span className="grow" />
        <button className="btn" onClick={() => api.openExternal(adminUrl)} title={adminUrl}>Consola de administração</button>
        <button className="btn" onClick={pickHome}>Escolher pasta…</button>
        {scan?.keycloakHome && scan.keycloakHome !== kc.home && (
          <button className="btn" onClick={() => onSaveSettings({ keycloak: { ...kc, home: scan.keycloakHome } })} title={scan.keycloakHome}>
            Usar a detetada no scan
          </button>
        )}
      </div>

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
              <h3>Instalados em <span className="mono">providers/</span></h3>
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
              <h3>Projetos SPI encontrados no scan</h3>
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
