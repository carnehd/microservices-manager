import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, GitSummary, ProcState, ScanResult, ServiceSettings, StartMode } from '../../shared/types'
import { api } from './api'
import { useLogs } from './hooks'
import { ContainersView } from './components/ContainersView'
import { KeycloakView } from './components/KeycloakView'
import { DiagnosticsView } from './components/DiagnosticsView'
import { DatabaseView } from './components/DatabaseView'
import { MapView } from './components/MapView'
import { RedisView } from './components/RedisView'
import { ServiceView } from './components/ServiceView'
import { SettingsView } from './components/SettingsView'
import { Sidebar } from './components/Sidebar'
import { Toast, type ToastMsg } from './components/Toast'
import { FolderPicker } from './components/FolderPicker'
import { StatusDot, isActive } from './components/common'

type View = 'services' | 'keycloak' | 'containers' | 'redis' | 'settings' | 'diagnostics' | 'map' | 'db'

export default function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [states, setStates] = useState<Record<string, ProcState>>({})
  const [view, setView] = useState<View>('services')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      return localStorage.getItem('msm.theme') === 'light' ? 'light' : 'dark'
    } catch {
      return 'dark'
    }
  })
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('msm.theme', theme)
    } catch {
      /* localStorage indisponível */
    }
  }, [theme])
  const [gitSummary, setGitSummary] = useState<GitSummary>({})
  const [toast, setToast] = useState<ToastMsg | null>(null)
  const [picker, setPicker] = useState<{ initial?: string; resolve: (dir: string | null) => void } | null>(null)
  const logs = useLogs()

  const notify = useCallback((text: string, kind: ToastMsg['kind'] = 'info') => setToast({ id: Date.now(), text, kind }), [])
  const fail = useCallback((e: unknown) => notify(e instanceof Error ? e.message : String(e), 'error'), [notify])
  const closeToast = useCallback(() => setToast(null), [])
  const pickFolder = useCallback((initial?: string) => new Promise<string | null>((resolve) => setPicker({ initial, resolve })), [])

  const rescan = useCallback(async (root?: string) => {
    setScanning(true)
    try {
      const r = await api.scan(root)
      setScan(r)
      if (!r.services.length) notify('Nenhum projeto Maven encontrado nesta pasta', 'info')
    } catch (e) {
      fail(e)
    } finally {
      setScanning(false)
    }
  }, [fail, notify])

  useEffect(() => {
    void (async () => {
      try {
        const s = await api.getSettings()
        setSettings(s)
        const st = await api.states()
        setStates(Object.fromEntries(st.map((x) => [x.id, x])))
        const last = await api.lastScan()
        if (last) setScan(last)
        else if (s.rootFolder) await rescan()
        else setView('settings')
      } catch (e) {
        fail(e)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const offState = api.onState((st) => setStates((prev) => ({ ...prev, [st.id]: st })))
    const offScan = api.onScanUpdated((r) => setScan(r))
    return () => {
      offState()
      offScan()
    }
  }, [])

  const refreshGit = useCallback(async () => {
    try {
      setGitSummary(await api.git.summary())
    } catch {
      /* sem git: fica vazio */
    }
  }, [])
  useEffect(() => {
    if (!scan) return
    void refreshGit()
    const t = setInterval(() => void refreshGit(), 15_000)
    return () => clearInterval(t)
  }, [scan, refreshGit])

  const saveSettings = useCallback(async (patch: Partial<AppSettings>): Promise<AppSettings | null> => {
    try {
      const s = await api.saveSettings(patch)
      setSettings(s)
      return s
    } catch (e) {
      fail(e)
      return null
    }
  }, [fail])

  const reloadSettings = useCallback(async () => {
    try {
      setSettings(await api.getSettings())
    } catch (e) {
      fail(e)
    }
  }, [fail])

  const saveServiceSettings = useCallback(async (id: string, ss: ServiceSettings, quiet = false) => {
    if (!settings) return
    await saveSettings({ services: { ...settings.services, [id]: ss } })
    if (!quiet) notify('Definições do serviço guardadas', 'success')
  }, [settings, saveSettings, notify])

  const pickRoot = async (): Promise<void> => {
    const dir = await pickFolder(settings?.rootFolder)
    if (!dir) return
    setSettings((s) => (s ? { ...s, rootFolder: dir } : s))
    setSelectedId(null)
    setView('services')
    await rescan(dir)
  }

  const start = async (id: string, mode: StartMode): Promise<void> => {
    try {
      await api.startService(id, mode)
    } catch (e) {
      fail(e)
    }
  }
  const startWithDeps = async (id: string, mode: StartMode): Promise<void> => {
    try {
      const r = await api.startWithDeps(id, mode)
      const parts = [r.started.length ? `arrancados: ${r.started.join(', ')}` : '', r.skipped.length ? `já a correr: ${r.skipped.filter((x) => x !== id).join(', ')}` : '', r.failed.length ? `falharam: ${r.failed.join(', ')}` : '']
      notify(parts.filter(Boolean).join(' · ') || 'sem dependências a arrancar', r.failed.length ? 'error' : 'success')
    } catch (e) {
      fail(e)
    }
  }
  const stop = async (id: string): Promise<void> => {
    try {
      await api.stop(id)
    } catch (e) {
      fail(e)
    }
  }
  const startAll = async (): Promise<void> => {
    for (const s of scan?.services ?? []) if (s.kind === 'spring-boot' && !isActive(states[s.id])) await start(s.id, settings?.services[s.id]?.debug ? 'debug' : 'run')
  }
  const stopAll = async (): Promise<void> => {
    for (const s of scan?.services ?? []) if (isActive(states[s.id])) await stop(s.id)
  }

  if (!settings) return <div className="loading">A carregar…</div>

  const selected = scan?.services.find((s) => s.id === selectedId) ?? null
  const runningCount = Object.values(states).filter(isActive).length

  return (
    <div className="app">
      <header className="topbar">
        <nav className="nav">
          <button className={view === 'services' ? 'active' : ''} onClick={() => setView('services')}>
            Serviços {runningCount > 0 && <span className="count">{runningCount}</span>}
          </button>
          <button className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}>Mapa</button>
          <button className={view === 'keycloak' ? 'active' : ''} onClick={() => setView('keycloak')}>
            <StatusDot status={states.keycloak?.status} /> Keycloak
          </button>
          <button className={view === 'containers' ? 'active' : ''} onClick={() => setView('containers')}>Containers</button>
          <button className={view === 'db' ? 'active' : ''} onClick={() => setView('db')}>BD</button>
          <button className={view === 'redis' ? 'active' : ''} onClick={() => setView('redis')}>Redis</button>
          <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>Definições</button>
          <button className={view === 'diagnostics' ? 'active' : ''} onClick={() => setView('diagnostics')}>Diagnóstico</button>
        </nav>
        <span className="grow" />
        <button className="btn btn-sm btn-ghost" title={theme === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
        <button className="btn btn-ghost mono small ellipsis root-path" title="Escolher pasta raiz" onClick={pickRoot}>
          {settings.rootFolder ?? 'Escolher pasta…'}
        </button>
        <button className="btn btn-sm" disabled={scanning || !settings.rootFolder} onClick={() => rescan()}>
          {scanning ? 'A analisar…' : '⟳ Rescan'}
        </button>
        <button className="btn btn-sm btn-primary" disabled={!scan?.services.length} onClick={startAll}>▶ Arrancar todos</button>
        <button className="btn btn-sm btn-danger" disabled={runningCount === 0} onClick={stopAll}>■ Parar todos</button>
      </header>

      <div className="body">
        {view === 'services' && (
          <>
            <Sidebar scan={scan} states={states} gitSummary={gitSummary} selectedId={selectedId} onSelect={setSelectedId} />
            {selected ? (
              <ServiceView
                key={selected.id}
                svc={selected}
                state={states[selected.id]}
                states={states}
                settings={settings}
                logs={logs}
                onStart={start}
                onStartWithDeps={startWithDeps}
                onStop={stop}
                onSaveServiceSettings={saveServiceSettings}
                onSettingsChanged={reloadSettings}
                onGitChanged={refreshGit}
                notify={notify}
                fail={fail}
              />
            ) : (
              <div className="empty grow">
                {scan?.services.length
                  ? 'Seleciona um serviço na lista.'
                  : settings.rootFolder
                    ? scanning ? 'A analisar a pasta…' : 'Nenhum projeto encontrado. Verifica a pasta raiz nas Definições.'
                    : 'Escolhe a pasta que contém os microserviços.'}
              </div>
            )}
          </>
        )}
        {view === 'keycloak' && (
          <KeycloakView settings={settings} scan={scan} states={states} logs={logs} onSaveSettings={saveSettings} notify={notify} fail={fail} />
        )}
        {view === 'containers' && <ContainersView logs={logs} states={states} notify={notify} fail={fail} />}
        {view === 'db' && <DatabaseView settings={settings} onSaveSettings={saveSettings} notify={notify} fail={fail} />}
        {view === 'redis' && <RedisView notify={notify} fail={fail} />}
        {view === 'map' && <MapView states={states} onSelect={(id) => { setSelectedId(id); setView('services') }} fail={fail} />}
        {view === 'diagnostics' && <DiagnosticsView fail={fail} notify={notify} />}
        {view === 'settings' && <SettingsView settings={settings} scan={scan} onSave={saveSettings} onRescan={() => rescan()} pickFolder={pickFolder} notify={notify} />}
      </div>

      <Toast msg={toast} onClose={closeToast} />
      {picker && (
        <FolderPicker
          initial={picker.initial}
          onClose={(dir) => {
            picker.resolve(dir)
            setPicker(null)
          }}
        />
      )}
    </div>
  )
}
