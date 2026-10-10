import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, ContainerRow, EngineInfo } from '../../shared/types'
import { api } from './api'
import { ContainerDetail, LogsPanel } from './components/ContainerDetail'
import { ContainersView } from './components/ContainersView'
import { CreateView } from './components/CreateView'
import { EventsView } from './components/EventsView'
import { ImagesView } from './components/ImagesView'
import { MachineView } from './components/MachineView'
import { SettingsView } from './components/SettingsView'
import { Terminal } from './components/Terminal'
import { NetworksView, VolumesView } from './components/VolumesNetworksView'
import { Modal, type Notify } from './components/common'

type View = 'containers' | 'images' | 'volumes' | 'networks' | 'events' | 'machine' | 'settings'
type Toast = { id: number; text: string; kind: 'error' | 'info' | 'success' }
const NAV: Array<[View, string]> = [['containers', 'Containers'], ['images', 'Images'], ['volumes', 'Volumes'], ['networks', 'Networks'], ['events', 'Events'], ['machine', 'Machine'], ['settings', 'Settings']]

export function App() {
  const [view, setView] = useState<View>('containers')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [engine, setEngine] = useState<EngineInfo | null>(null)
  const [detail, setDetail] = useState<{ c: ContainerRow; tab?: 'logs' | 'shell' } | null>(null)
  const [create, setCreate] = useState<{ image?: string } | null>(null)
  const [multi, setMulti] = useState<string[] | null>(null)
  const [runningCount, setRunningCount] = useState(0)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [theme, setTheme] = useState<'dark' | 'light'>(() => { try { return (localStorage.getItem('cm.theme') as 'dark' | 'light') || 'dark' } catch { return 'dark' } })

  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem('cm.theme', theme) } catch { /* */ } }, [theme])
  const notify: Notify = useCallback((text, kind = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4000)
  }, [])
  const refreshEngine = useCallback(async () => { try { setEngine(await api.engine()) } catch (e) { setEngine({ command: 'podman', ok: false, error: e instanceof Error ? e.message : String(e), machines: [], isPodman: true }) } }, [])
  useEffect(() => {
    void api.settings().then(setSettings).catch((e) => notify(String(e), 'error'))
    void refreshEngine()
    const t = setInterval(() => { if (document.visibilityState === 'visible') void refreshEngine() }, 30_000)
    return () => clearInterval(t)
  }, [notify, refreshEngine])
  // contador de containers a correr na navegação (leitura quiet)
  useEffect(() => {
    const load = (): void => { void api.containers.list(true).then((l) => setRunningCount(l.filter((c) => c.state === 'running').length)).catch(() => {}) }
    load(); const t = setInterval(() => { if (document.visibilityState === 'visible') load() }, Math.max(settings?.refreshMs || 15000, 5000))
    return () => clearInterval(t)
  }, [settings?.refreshMs, view])
  const saveSettings = async (p: Partial<AppSettings>): Promise<void> => { setSettings(await api.saveSettings(p)); await refreshEngine() }
  const go = (v: View): void => { setView(v); setDetail(null); setCreate(null) }
  const refreshMs = settings?.refreshMs ?? 5000
  const machine = engine?.machines.find((m) => m.default) ?? engine?.machines[0]

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2"><path d="M3 9h18v10H3zM7 5h10v4H7z" /></svg>
          Containers Manager
        </div>
        <nav className="nav">
          {NAV.map(([v, label]) => <button key={v} className={view === v ? 'active' : ''} onClick={() => go(v)}>{label}{v === 'containers' && runningCount > 0 && <span className="count">{runningCount}</span>}</button>)}
        </nav>
        <span className="grow" />
        <div className="engine-status" title={engine?.error ?? ''}>
          <span className={`dot ${engine?.ok ? 'dot-running' : 'dot-stopped'}`} />
          {engine ? (engine.ok ? <>{engine.command} {engine.serverVersion}{machine ? <> · machine <b style={{ color: 'var(--text)' }}>{machine.name}</b> {machine.running ? 'running' : 'stopped'}</> : null}</> : <span className="text-error">{engine.error?.slice(0, 70)}</span>) : '…'}
        </div>
        {engine?.isPodman && machine && (
          <button className="btn btn-sm" onClick={() => go('machine')}>{machine.running ? 'Machine…' : '▶ Start machine'}</button>
        )}
        <button className="btn btn-sm" aria-label="tema" title="tema claro/escuro" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}>{theme === 'dark' ? '☀' : '☾'}</button>
      </div>

      <div className="main">
        {settings && (
          detail ? <ContainerDetail container={detail.c} initialTab={detail.tab} logsTail={settings.logsTail} notify={notify} onBack={() => setDetail(null)} onChanged={refreshEngine} />
          : create ? <CreateView settings={settings} initialImage={create.image} notify={notify} onBack={() => setCreate(null)} onCreated={() => { setCreate(null); setView('containers') }} onSaveSettings={saveSettings} />
          : view === 'containers' ? <ContainersView refreshMs={refreshMs} notify={notify} onOpen={(c, tab) => setDetail({ c, tab })} onCreate={() => setCreate({})} onMultiLogs={(ids) => setMulti(ids)} />
          : view === 'images' ? <ImagesView refreshMs={refreshMs} notify={notify} onRunImage={(ref) => setCreate({ image: ref })} />
          : view === 'volumes' ? <VolumesView refreshMs={refreshMs} notify={notify} />
          : view === 'networks' ? <NetworksView refreshMs={refreshMs} notify={notify} />
          : view === 'events' ? <EventsView notify={notify} />
          : view === 'machine' ? <MachineView engine={engine} onRefresh={refreshEngine} notify={notify} />
          : <SettingsView settings={settings} onSave={saveSettings} notify={notify} theme={theme} onTheme={setTheme} />
        )}
        {!settings && <div className="pad muted">A carregar…</div>}
      </div>

      {multi && (
        <Modal title={`Logs em conjunto — ${multi.join(', ')}`} onClose={() => setMulti(null)} width={1100}>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(multi.length, 2)}, minmax(0, 1fr))`, gap: 12 }}>
            {multi.map((name) => <div key={name}><div className="mono small" style={{ marginBottom: 6 }}>{name}</div><LogsPanel name={name} tail={settings?.logsTail ?? 200} notify={notify} /></div>)}
          </div>
        </Modal>
      )}
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>
      <Terminal />
    </div>
  )
}
