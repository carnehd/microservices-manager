import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppSettings, GitSummary, ProcState, ScanResult, ServiceSettings, StartMode } from '../../shared/types'
import { api, POLL } from './api'
import { useLogs } from './hooks'
import { ContainersView } from './components/ContainersView'
import { KeycloakView } from './components/KeycloakView'
import { DiagnosticsView } from './components/DiagnosticsView'
import { GrafanaView } from './components/GrafanaView'
import { PubSubView } from './components/PubSubView'
import { SearchView } from './components/SearchView'
import { MapView } from './components/MapView'
import { RedisView } from './components/RedisView'
import { ServiceView } from './components/ServiceView'
import { SettingsView } from './components/SettingsView'
import { Sidebar } from './components/Sidebar'
import { Toast, type ToastMsg } from './components/Toast'
import { Terminal } from './components/Terminal'
import { FolderPicker } from './components/FolderPicker'
import { NavDot, type NavState, isActive } from './components/common'

type View = 'services' | 'keycloak' | 'containers' | 'redis' | 'settings' | 'diagnostics' | 'map' | 'grafana' | 'pubsub' | 'search'

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
  const [kcProviders, setKcProviders] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<ToastMsg | null>(null)
  const [picker, setPicker] = useState<{ initial?: string; resolve: (dir: string | null) => void } | null>(null)
  const [navDots, setNavDots] = useState<{ keycloak: NavState; containers: NavState; redis: NavState; pubsub: NavState }>({ keycloak: 'none', containers: 'none', redis: 'none', pubsub: 'none' })
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
      if (!r.services.length) notify('No Maven project found in this folder', 'info')
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
  const refreshKcProviders = useCallback(async () => {
    try {
      const p = await api.kcAdmin.providers()
      setKcProviders(new Set(p.flatMap((x) => x.providers)))
    } catch {
      setKcProviders(new Set()) // Keycloak parado / admin não acessível
    }
  }, [])
  useEffect(() => {
    if (!scan) return
    void refreshGit()
    const t = setInterval(() => void refreshGit(), 15_000)
    return () => clearInterval(t)
  }, [scan, refreshGit])
  useEffect(() => {
    if (!scan) return
    void refreshKcProviders()
    const t = setInterval(() => void refreshKcProviders(), 15_000)
    return () => clearInterval(t)
  }, [scan, states.keycloak?.status, refreshKcProviders])
  // Bolinhas de estado da navegação (Keycloak / Containers / Redis / Pub/Sub): verde a correr, vermelho erro, sem cor parado.
  useEffect(() => {
    let alive = true
    let running = false // evita acumular pedidos quando o motor está lento (PC da empresa)
    const tick = async (): Promise<void> => {
      if (running) return
      running = true
      // POLL = de fundo (silencioso) + fresh: é isto que mantém a cache do servidor atualizada
      const [kc, cts, rd, ps] = await Promise.allSettled([api.kcInfo(POLL), api.containers.list(POLL), api.redis.info(POLL), api.pubsub.info(POLL)]).finally(() => { running = false })
      if (!alive) return
      const keycloak: NavState = kc.status === 'fulfilled' ? (kc.value.container?.running ? 'running' : kc.value.engineError ? 'error' : 'none') : 'error'
      const containers: NavState = cts.status === 'fulfilled' ? (cts.value.some((c) => c.state === 'running') ? 'running' : 'none') : 'error'
      const redis: NavState = rd.status === 'fulfilled' ? (rd.value.connected ? 'running' : rd.value.error ? 'error' : 'none') : 'error'
      const pubsub: NavState = ps.status === 'fulfilled' ? (ps.value.running ? 'running' : ps.value.error || !ps.value.engineOk ? 'error' : 'none') : 'error'
      setNavDots({ keycloak, containers, redis, pubsub })
    }
    void tick()
    const t = setInterval(() => void tick(), 7_000)
    return () => { alive = false; clearInterval(t) }
  }, [])

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
    if (!quiet) notify('Service settings saved', 'success')
  }, [settings, saveSettings, notify])

  const favorites = useMemo(
    () => new Set(Object.entries(settings?.services ?? {}).filter(([, ss]) => ss?.favorite).map(([id]) => id)),
    [settings]
  )
  const toggleFavorite = useCallback(async (id: string) => {
    if (!settings) return
    const cur = settings.services[id] ?? {}
    await saveServiceSettings(id, { ...cur, favorite: !cur.favorite }, true)
  }, [settings, saveServiceSettings])

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
      const parts = [r.started.length ? `started: ${r.started.join(', ')}` : '', r.skipped.length ? `already running: ${r.skipped.filter((x) => x !== id).join(', ')}` : '', r.failed.length ? `failed: ${r.failed.join(', ')}` : '']
      notify(parts.filter(Boolean).join(' · ') || 'no dependencies to start', r.failed.length ? 'error' : 'success')
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

  if (!settings) return <div className="loading">Loading…</div>

  const selected = scan?.services.find((s) => s.id === selectedId) ?? null
  const runningCount = Object.values(states).filter(isActive).length

  return (
    <div className="app">
      <header className="topbar">
        <nav className="nav">
          <button className={view === 'services' ? 'active' : ''} onClick={() => setView('services')}>
            Services {runningCount > 0 && <span className="count">{runningCount}</span>}
          </button>
          <button className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}>Map</button>
          <button className={view === 'search' ? 'active' : ''} onClick={() => setView('search')}>Search</button>
          <button className={view === 'keycloak' ? 'active' : ''} onClick={() => setView('keycloak')}>
            <NavDot state={navDots.keycloak} /> Keycloak
          </button>
          <button className={view === 'containers' ? 'active' : ''} onClick={() => setView('containers')}>
            <NavDot state={navDots.containers} /> Containers
          </button>
          <button className={view === 'redis' ? 'active' : ''} onClick={() => setView('redis')}>
            <NavDot state={navDots.redis} /> Redis
          </button>
          <button className={view === 'pubsub' ? 'active' : ''} onClick={() => setView('pubsub')}>
            <NavDot state={navDots.pubsub} /> Pub/Sub
          </button>
          <button className={view === 'grafana' ? 'active' : ''} onClick={() => setView('grafana')}>Logs (Grafana)</button>
          <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>Settings</button>
          <button className={view === 'diagnostics' ? 'active' : ''} onClick={() => setView('diagnostics')}>Diagnostics</button>
        </nav>
        <span className="grow" />
        <button className="btn btn-sm btn-ghost" title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
        <button className="btn btn-ghost mono small ellipsis root-path" title="Choose root folder" onClick={pickRoot}>
          {settings.rootFolder ?? 'Choose folder…'}
        </button>
        <button className="btn btn-sm" disabled={scanning || !settings.rootFolder} onClick={() => rescan()}>
          {scanning ? 'Scanning…' : '⟳ Rescan'}
        </button>
        <button className="btn btn-sm btn-primary" disabled={!scan?.services.length} onClick={startAll}>▶ Start all</button>
        <button className="btn btn-sm btn-danger" disabled={runningCount === 0} onClick={stopAll}>■ Stop all</button>
      </header>

      <div className="body">
        {view === 'services' && (
          <>
            <Sidebar scan={scan} states={states} gitSummary={gitSummary} kcProviders={kcProviders} favorites={favorites} selectedId={selectedId} onSelect={setSelectedId} onToggleFavorite={toggleFavorite} />
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
                  ? 'Select a service from the list.'
                  : settings.rootFolder
                    ? scanning ? 'Scanning the folder…' : 'No project found. Check the root folder in Settings.'
                    : 'Choose the folder containing the microservices.'}
              </div>
            )}
          </>
        )}
        {view === 'keycloak' && (
          <KeycloakView settings={settings} scan={scan} states={states} logs={logs} onSaveSettings={saveSettings} notify={notify} fail={fail} />
        )}
        {view === 'containers' && <ContainersView logs={logs} states={states} notify={notify} fail={fail} />}
        {view === 'redis' && <RedisView notify={notify} fail={fail} />}
        {view === 'grafana' && <GrafanaView settings={settings} onSaveSettings={saveSettings} notify={notify} fail={fail} />}
        {view === 'pubsub' && <PubSubView settings={settings} scan={scan} onSaveSettings={saveSettings} notify={notify} fail={fail} />}
        {view === 'search' && <SearchView notify={notify} fail={fail} />}
        {view === 'map' && <MapView states={states} onSelect={(id) => { setSelectedId(id); setView('services') }} fail={fail} />}
        {view === 'diagnostics' && <DiagnosticsView fail={fail} notify={notify} />}
        {view === 'settings' && <SettingsView settings={settings} scan={scan} onSave={saveSettings} onRescan={() => rescan()} pickFolder={pickFolder} notify={notify} />}
      </div>

      <Terminal />

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
