import { useCallback, useEffect, useState } from 'react'
import type { JarInfo, ServiceInfo } from '../../../shared/types'
import { api } from '../api'
import { Badge } from './common'

type Notify = (t: string, k?: 'error' | 'info' | 'success') => void

function fmt(mtime: number, size: number): string {
  return `${new Date(mtime).toLocaleString()} · ${Math.round(size / 1024)} KB`
}

export function JarsView({ svc, notify, fail }: { svc: ServiceInfo; notify: Notify; fail: (e: unknown) => void }) {
  const [info, setInfo] = useState<JarInfo | null>(null)
  const [loadedIds, setLoadedIds] = useState<Set<string> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [restart, setRestart] = useState(true)
  const providerIds = svc.providerIds ?? []

  const load = useCallback(async () => {
    try {
      setInfo(await api.jarInfo(svc.id))
    } catch (e) {
      fail(e)
    }
    try {
      const provs = await api.kcAdmin.providers()
      setLoadedIds(new Set(provs.flatMap((p) => p.providers)))
    } catch {
      setLoadedIds(null)
    }
  }, [svc.id, fail])
  useEffect(() => {
    void load()
  }, [load])

  const act = async (label: string, fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(label)
    try {
      await fn()
      notify(done, 'success')
      await load()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  if (!info) return <div className="empty">Reading target/…</div>
  const loaded = loadedIds && providerIds.some((id) => loadedIds.has(id))

  return (
    <div className="config">
      <section>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <h3 className="grow">Jars generated in <span className="mono">target/</span></h3>
          {providerIds.length > 0 && (loadedIds === null
            ? <span className="muted small">unknown state (connect in Administration)</span>
            : loaded ? <Badge tone="green" title={providerIds.join(', ')}>✓ loaded in Keycloak</Badge>
            : <Badge tone="muted" title={providerIds.join(', ')}>not loaded</Badge>)}
          <label className="switch small" title="Restart Keycloak after installing, to load the provider">
            <input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} />
            <span className="switch-track"><span className="switch-knob" /></span>
            <span className="switch-label">restart afterwards</span>
          </label>
          <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => act('build', () => api.kcDeploySpi(svc.id, { build: true, restart }), 'Compiled and installed')} title="mvn package + copy the newest jar to providers">
            {busy === 'build' ? 'Compiling…' : 'Build & install'}
          </button>
          <button className="btn btn-sm" disabled={!!busy} onClick={load}>⟳</button>
        </div>
        <table className="grid">
          <thead><tr><th>Jar</th><th>Version</th><th>Date · size</th><th></th></tr></thead>
          <tbody>
            {info.candidates.map((j) => {
              const inst = info.installed.some((i) => i.name === j.name)
              return (
                <tr key={j.name}>
                  <td className="mono small">{j.name}</td>
                  <td className="mono small">{j.version ?? '—'}</td>
                  <td className="small muted">{fmt(j.mtime, j.size)}</td>
                  <td className="cell-actions">
                    {inst ? <Badge tone="green">installed</Badge> : null}
                    <button className="btn btn-sm" disabled={!!busy} title="copy this jar to the Keycloak providers folder"
                      onClick={() => act(j.name, () => api.kcDeploySpi(svc.id, { build: false, restart, jar: j.name }), `${j.name} installed`)}>
                      {busy === j.name ? '…' : 'Install'}
                    </button>
                  </td>
                </tr>
              )
            })}
            {!info.candidates.length && <tr><td colSpan={4} className="muted">No jars in target/ — compile in IntelliJ or use "Build & install".</td></tr>}
          </tbody>
        </table>
      </section>

      <section>
        <h3>Installed in <span className="mono">providers/</span></h3>
        {!info.installed.length && <p className="muted">No jar from this SPI in providers/.</p>}
        {info.installed.length > 0 && (
          <table className="grid">
            <thead><tr><th>Jar</th><th>Version</th><th>Date · size</th><th></th></tr></thead>
            <tbody>
              {info.installed.map((i) => (
                <tr key={i.name}>
                  <td className="mono small">{i.name}</td>
                  <td className="mono small">{i.version ?? '—'}</td>
                  <td className="small muted">{fmt(i.mtime, i.size)}</td>
                  <td className="cell-actions">
                    <button className="btn btn-sm btn-danger" disabled={!!busy}
                      onClick={() => { if (confirm(`Remove ${i.name} from providers/?`)) void act(i.name, () => api.kcRemoveProvider(i.name), `${i.name} removed`) }}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">Changes in providers/ are only loaded after restarting Keycloak.</p>
      </section>
    </div>
  )
}
