import { useEffect, useMemo, useState } from 'react'
import type { ContainerEvent } from '../../../shared/types'
import { api } from '../api'
import { useStream } from '../hooks'
import { PageHeader, Pill, errMsg, type Notify } from './common'

/** Eventos do motor em tempo real (podman events --format json). */
export function EventsView({ notify }: { notify: Notify }) {
  const [streamId, setStreamId] = useState<string | null>(null)
  const { lines, ended, clear } = useStream(streamId, 1000)
  const [filter, setFilter] = useState('')
  const start = async (): Promise<void> => { try { const r = await api.engineEvents(); setStreamId(r.stream) } catch (e) { notify(errMsg(e), 'error') } }
  useEffect(() => { void start() // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const events = useMemo(() => lines.filter((l) => l.stream === 'stdout').map((l): ContainerEvent | null => {
    try {
      const j = JSON.parse(l.text) as Record<string, unknown>
      const t = typeof j.Time === 'string' ? Date.parse(j.Time) : typeof j.time === 'number' ? j.time * 1000 : l.ts
      return { ts: isNaN(t) ? l.ts : t, type: String(j.Type ?? ''), status: String(j.Status ?? ''), name: String(j.Name ?? ''), image: typeof j.Image === 'string' ? j.Image : undefined, id: typeof j.ID === 'string' ? j.ID.slice(0, 12) : undefined }
    } catch { return null }
  }).filter((e): e is ContainerEvent => !!e).filter((e) => !filter || `${e.type} ${e.status} ${e.name} ${e.image ?? ''}`.toLowerCase().includes(filter.toLowerCase())).reverse(), [lines, filter])
  const tone = (s: string): 'green' | 'red' | 'amber' | 'muted' | 'blue' => (/start|create|pull|connect/.test(s) ? 'green' : /die|kill|remove|oom|delete/.test(s) ? 'red' : /stop|pause|health_status/.test(s) ? 'amber' : /exec/.test(s) ? 'blue' : 'muted')
  return (
    <div className="page">
      <PageHeader title="Events" count={`${events.length} evento(s)${ended !== undefined ? ' · stream parado' : ''}`} onRefresh={() => { clear(); void start() }}>
        <label className="search" style={{ width: 260 }}><input placeholder="filtrar…" value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
        <button className="btn btn-sm" onClick={clear}>Clear</button>
        {streamId && ended === undefined && <button className="btn btn-sm" onClick={() => void api.stopStream(streamId)}>■ Parar</button>}
      </PageHeader>
      <div className="table">
        <div className="thead" style={{ gridTemplateColumns: '170px 90px 130px minmax(0,1fr) minmax(0,1fr)' }}><span>Quando</span><span>Tipo</span><span>Estado</span><span>Nome</span><span>Imagem</span></div>
        {events.map((e, i) => (
          <div key={i} className="tr" style={{ gridTemplateColumns: '170px 90px 130px minmax(0,1fr) minmax(0,1fr)', minHeight: 36 }}>
            <span className="mono tiny muted">{new Date(e.ts).toLocaleString()}</span><span className="small">{e.type}</span><span><Pill tone={tone(e.status)}>{e.status}</Pill></span><span className="mono small ellipsis">{e.name || e.id || ''}</span><span className="mono tiny muted ellipsis">{e.image ?? ''}</span>
          </div>
        ))}
        {!events.length && <div className="tr muted" style={{ gridTemplateColumns: '1fr' }}>À espera de eventos (arranca/pára um container para ver aqui)…</div>}
      </div>
    </div>
  )
}
