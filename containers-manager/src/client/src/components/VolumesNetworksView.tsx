import { useState } from 'react'
import type { ContainerRow } from '../../../shared/types'
import { api } from '../api'
import { usePoll } from '../hooks'
import { PageHeader, errMsg, type Notify } from './common'

export function VolumesView({ refreshMs, notify }: { refreshMs: number; notify: Notify }) {
  const { data, error, refresh, loading } = usePoll((q) => api.volumes.list(q), refreshMs * 3)
  const [name, setName] = useState('')
  const act = async (label: string, fn: () => Promise<{ code: number; stderr: string }>): Promise<void> => {
    try { const r = await fn(); if (r.code) notify(r.stderr.trim().split('\n').pop() || 'falhou', 'error'); else notify(`${label} ✓`, 'success'); await refresh() } catch (e) { notify(errMsg(e), 'error') }
  }
  const cols = 'minmax(0,1fr) 100px minmax(0,1.4fr) 160px 120px'
  return (
    <div className="page">
      <PageHeader title="Volumes" count={`${(data ?? []).length}`} onRefresh={() => void refresh()} loading={loading}>
        <input className="input mono" style={{ width: 220 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="nome do novo volume" />
        <button className="btn btn-primary" disabled={!name.trim()} onClick={() => void act(`volume ${name}`, () => api.volumes.create(name.trim())).then(() => setName(''))}>＋ Criar</button>
        <button className="btn btn-warn" onClick={() => { if (confirm('Remover todos os volumes não usados por nenhum container?')) void act('prune', () => api.volumes.prune()) }}>Prune não usados</button>
      </PageHeader>
      {error && <div className="text-error small">{error}</div>}
      <div className="table">
        <div className="thead" style={{ gridTemplateColumns: cols }}><span>Nome</span><span>Driver</span><span>Mountpoint</span><span>Criado</span><span /></div>
        {(data ?? []).map((v) => (
          <div key={v.name} className="tr" style={{ gridTemplateColumns: cols, minHeight: 44 }}>
            <span className="mono small ellipsis">{v.name}</span><span className="small muted">{v.driver}</span><span className="mono tiny muted ellipsis" title={v.mountpoint}>{v.mountpoint}</span><span className="small muted">{v.created?.slice(0, 19).replace('T', ' ') ?? ''}</span>
            <div className="actions"><button className="btn btn-sm btn-danger" onClick={() => { if (confirm(`Remover o volume ${v.name}? Os dados perdem-se.`)) void act(`rm ${v.name}`, () => api.volumes.remove(v.name, true)) }}>Remove</button></div>
          </div>
        ))}
        {data && !data.length && <div className="tr muted" style={{ gridTemplateColumns: '1fr' }}>Nenhum volume.</div>}
      </div>
      <p className="muted small">Para ver o conteúdo de um volume: cria um container temporário com ele montado (Novo container → Volumes) e usa a Shell, ou <span className="mono">podman volume inspect</span> na Consola.</p>
    </div>
  )
}

export function NetworksView({ refreshMs, notify }: { refreshMs: number; notify: Notify }) {
  const { data, error, refresh, loading } = usePoll((q) => api.networks.list(q), refreshMs * 3)
  const containers = usePoll((q) => api.containers.list(q), refreshMs * 3).data ?? []
  const [name, setName] = useState('')
  const [pick, setPick] = useState<Record<string, string>>({})
  const act = async (label: string, fn: () => Promise<{ code: number; stderr: string }>): Promise<void> => {
    try { const r = await fn(); if (r.code) notify(r.stderr.trim().split('\n').pop() || 'falhou', 'error'); else notify(`${label} ✓`, 'success'); await refresh() } catch (e) { notify(errMsg(e), 'error') }
  }
  const cols = '180px 100px 160px minmax(0,1fr) 420px'
  return (
    <div className="page">
      <PageHeader title="Networks" count={`${(data ?? []).length}`} onRefresh={() => void refresh()} loading={loading}>
        <input className="input mono" style={{ width: 220 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="nome da nova rede" />
        <button className="btn btn-primary" disabled={!name.trim()} onClick={() => void act(`network ${name}`, () => api.networks.create(name.trim())).then(() => setName(''))}>＋ Criar</button>
      </PageHeader>
      {error && <div className="text-error small">{error}</div>}
      <div className="table">
        <div className="thead" style={{ gridTemplateColumns: cols }}><span>Nome</span><span>Driver</span><span>Subnets</span><span>Containers</span><span /></div>
        {(data ?? []).map((n) => {
          const members = (containers as ContainerRow[]).filter((c) => c.networks.includes(n.name))
          return (
            <div key={n.name} className="tr" style={{ gridTemplateColumns: cols }}>
              <span className="mono small">{n.name}{n.dns ? <span className="dim tiny"> · dns</span> : null}</span><span className="small muted">{n.driver}</span><span className="mono tiny muted">{n.subnets.join(', ')}</span>
              <span className="small ellipsis">{members.map((m) => m.name).join(', ') || <span className="dim">—</span>}</span>
              <div className="actions">
                <select className="input sm mono" value={pick[n.name] ?? ''} onChange={(e) => setPick((p) => ({ ...p, [n.name]: e.target.value }))}><option value="">container…</option>{(containers as ContainerRow[]).map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}</select>
                <button className="btn btn-sm" disabled={!pick[n.name]} onClick={() => void act('connect', () => api.networks.connect(n.name, pick[n.name]))}>Ligar</button>
                <button className="btn btn-sm" disabled={!pick[n.name]} onClick={() => void act('disconnect', () => api.networks.disconnect(n.name, pick[n.name]))}>Desligar</button>
                <button className="btn btn-sm btn-danger" disabled={n.name === 'podman' || n.name === 'bridge'} onClick={() => { if (confirm(`Remover a rede ${n.name}?`)) void act(`rm ${n.name}`, () => api.networks.remove(n.name)) }}>Remove</button>
              </div>
            </div>
          )
        })}
        {data && !data.length && <div className="tr muted" style={{ gridTemplateColumns: '1fr' }}>Nenhuma rede.</div>}
      </div>
      <p className="muted small">Containers na mesma rede (criada por ti, com DNS) falam entre si pelo nome; na rede default do podman não há DNS — usa <span className="mono">host.containers.internal:&lt;porta publicada&gt;</span>.</p>
    </div>
  )
}
