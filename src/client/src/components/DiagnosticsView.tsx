import { useCallback, useEffect, useState } from 'react'
import type { DiagReport, DiagStatus } from '../../../shared/types'
import { api } from '../api'

type Notify = (t: string, k?: 'error' | 'info' | 'success') => void
const ICON: Record<DiagStatus, string> = { ok: '✓', warn: '⚠', fail: '✗', info: 'ℹ' }
const LABEL: Record<DiagStatus, string> = { ok: 'ok', warn: 'warning', fail: 'problem', info: 'info' }

export function DiagnosticsView({ fail, notify }: { fail: (e: unknown) => void; notify: Notify }) {
  const [report, setReport] = useState<DiagReport | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      setReport(await api.diagnostics())
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }, [fail])

  useEffect(() => {
    void load()
  }, [load])

  const copy = async (): Promise<void> => {
    if (!report) return
    const lines = [`Microservices Manager — diagnostics ${new Date(report.generatedAt).toLocaleString()} (${report.platform})`, '']
    let g = ''
    for (const it of report.items) {
      if (it.group !== g) {
        g = it.group
        lines.push(`## ${g}`)
      }
      lines.push(`[${LABEL[it.status].toUpperCase()}] ${it.name}: ${it.detail}${it.hint ? ` → ${it.hint}` : ''}`)
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      notify('Report copied', 'success')
    } catch {
      notify('Could not copy to clipboard', 'error')
    }
  }

  const counts = { ok: 0, warn: 0, fail: 0, info: 0 }
  for (const it of report?.items ?? []) counts[it.status]++
  const groups = [...new Set((report?.items ?? []).map((i) => i.group))]

  return (
    <main className="service">
      <div className="svc-header">
        <div className="grow">
          <h2>Diagnostics</h2>
          <div className="muted small">
            {report ? `${report.platform} · ${new Date(report.generatedAt).toLocaleTimeString()} · ${counts.fail} problem(s), ${counts.warn} warning(s)` : 'checking…'}
          </div>
        </div>
      </div>
      <div className="actions">
        <button className="btn" disabled={busy} onClick={load}>{busy ? 'Checking…' : '⟳ Check again'}</button>
        <button className="btn" disabled={!report} onClick={copy} title="Copies a text summary to paste into an email/chat">Copy report</button>
      </div>
      <div className="tab-body">
        <div className="config">
          {groups.map((g) => (
            <section key={g}>
              <h3>{g}</h3>
              <table className="grid diag">
                <tbody>
                  {report!.items.filter((i) => i.group === g).map((it, idx) => (
                    <tr key={idx}>
                      <td className={`diag-status diag-${it.status}`} title={LABEL[it.status]}>{ICON[it.status]}</td>
                      <td className="diag-name">{it.name}</td>
                      <td className="mono small">{it.detail}{it.hint && <div className="diag-hint">→ {it.hint}</div>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
          {!report && !busy && <div className="empty">No report.</div>}
        </div>
      </div>
    </main>
  )
}
