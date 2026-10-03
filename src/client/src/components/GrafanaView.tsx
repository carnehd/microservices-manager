import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, GrafanaLogLine, GrafanaSettings } from '../../../shared/types'
import { api } from '../api'

type Notify = (t: string, k?: 'error' | 'info' | 'success') => void
type SaveSettings = (patch: Partial<AppSettings>) => Promise<AppSettings | null>

const LEVEL_TONE: Record<string, string> = {
  ERROR: 'red', FATAL: 'red', WARN: 'amber', WARNING: 'amber', INFO: 'green', DEBUG: 'muted', TRACE: 'muted'
}

function hhmmss(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString()
  } catch {
    return iso
  }
}

export function GrafanaView({ settings, onSaveSettings, notify, fail }: {
  settings: AppSettings; onSaveSettings: SaveSettings; notify: Notify; fail: (e: unknown) => void
}) {
  const g = settings.grafana ?? {}
  const [form, setForm] = useState<GrafanaSettings>({
    url: g.url ?? '', token: g.token ?? '', datasourceUid: g.datasourceUid ?? '',
    datasourceType: g.datasourceType ?? 'loki', query: g.query ?? '', orgId: g.orgId
  })
  const [sinceMinutes, setSinceMinutes] = useState(60)
  const [limit, setLimit] = useState(200)
  const [logs, setLogs] = useState<GrafanaLogLine[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [auto, setAuto] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const set = <K extends keyof GrafanaSettings>(k: K, v: GrafanaSettings[K]) => setForm((f) => ({ ...f, [k]: v }))

  const configured = Boolean(form.url && form.token && form.datasourceUid && form.query)

  const fetchLogs = useCallback(async () => {
    setBusy('logs')
    try {
      const r = await api.grafana.logs({ cfg: form, query: form.query, limit, sinceMinutes })
      setLogs(r)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }, [form, limit, sinceMinutes, fail])

  const test = async () => {
    setBusy('test')
    try {
      const r = await api.grafana.test(form)
      notify(`Connected to Grafana · datasource "${r.datasourceName}" (${r.datasourceType})`, 'success')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    setBusy('save')
    try {
      const orgId = form.orgId ? Number(form.orgId) : undefined
      await onSaveSettings({ grafana: { ...form, orgId } })
      notify('Grafana configuration saved', 'success')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    if (!auto) {
      if (timer.current) clearInterval(timer.current)
      timer.current = null
      return
    }
    timer.current = setInterval(() => void fetchLogs(), 10_000)
    return () => {
      if (timer.current) clearInterval(timer.current)
    }
  }, [auto, fetchLogs])

  return (
    <div className="grafana-view">
      <div className="grafana-config">
        <h3>Grafana connection</h3>
        <p className="muted small">Shows logs from a Grafana <b>Loki</b> datasource. You need the URL, a <b>Service Account Token</b> (Viewer role), the datasource <b>uid</b> and the LogQL <b>query</b>.</p>
        <label className="field"><span>Grafana URL</span>
          <input className="input" placeholder="http://localhost:3000" value={form.url ?? ''} onChange={(e) => set('url', e.target.value)} />
        </label>
        <label className="field"><span>Token (Service Account)</span>
          <span className="input-row">
            <input className="input" type={showToken ? 'text' : 'password'} placeholder="glsa_…" value={form.token ?? ''} onChange={(e) => set('token', e.target.value)} />
            <button className="btn btn-sm" type="button" onClick={() => setShowToken((v) => !v)}>{showToken ? 'hide' : 'show'}</button>
          </span>
        </label>
        <div className="field-row">
          <label className="field"><span>Datasource uid (Loki)</span>
            <input className="input" placeholder="e.g. cg01dk1itp62oa" value={form.datasourceUid ?? ''} onChange={(e) => set('datasourceUid', e.target.value)} />
          </label>
          <label className="field field-sm"><span>Org ID (optional)</span>
            <input className="input" placeholder="1" value={form.orgId ?? ''} onChange={(e) => set('orgId', e.target.value ? Number(e.target.value) : undefined)} />
          </label>
        </div>
        <label className="field"><span>Query (LogQL)</span>
          <input className="input mono" placeholder={'{app="ms-cliente-perfil"}'} value={form.query ?? ''} onChange={(e) => set('query', e.target.value)} />
        </label>
        <div className="grafana-actions">
          <button className="btn btn-sm" disabled={busy !== null} onClick={test}>Test connection</button>
          <button className="btn btn-sm btn-primary" disabled={busy !== null} onClick={save}>Save</button>
        </div>
      </div>

      <div className="grafana-logs-pane">
        <div className="grafana-toolbar">
          <label className="inline">last
            <select className="input input-inline" value={sinceMinutes} onChange={(e) => setSinceMinutes(Number(e.target.value))}>
              <option value={15}>15 min</option>
              <option value={60}>1 hour</option>
              <option value={360}>6 hours</option>
              <option value={1440}>24 hours</option>
            </select>
          </label>
          <label className="inline">limit
            <select className="input input-inline" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              <option value={100}>100</option>
              <option value={200}>200</option>
              <option value={500}>500</option>
              <option value={1000}>1000</option>
            </select>
          </label>
          <label className="inline"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto (10s)</label>
          <span className="grow" />
          <span className="muted small">{logs.length} {logs.length === 1 ? 'line' : 'lines'}</span>
          <button className="btn btn-sm btn-primary" disabled={!configured || busy === 'logs'} onClick={() => void fetchLogs()}>
            {busy === 'logs' ? 'Loading…' : '⟳ Refresh'}
          </button>
        </div>
        <div className="grafana-logs">
          {!configured && <div className="muted pad">Fill in the configuration and click <b>Refresh</b>.</div>}
          {configured && !logs.length && busy !== 'logs' && <div className="muted pad">No logs in this period. Adjust the query or the range.</div>}
          {logs.map((l, i) => (
            <div className="glog-row" key={l.tsNano + i}>
              <span className="glog-time" title={l.ts}>{hhmmss(l.ts)}</span>
              {l.level && <span className={`glog-lvl tone-${LEVEL_TONE[l.level] ?? 'muted'}`}>{l.level}</span>}
              <span className="glog-msg">{l.line}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
