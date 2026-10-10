import { useEffect, useMemo, useState } from 'react'
import type { ContainerRow, StatsRow } from '../../../shared/types'
import { api } from '../api'
import { usePoll } from '../hooks'
import { Dot, Modal, PageHeader, Pill, errMsg, type Notify } from './common'

export function ContainersView({ refreshMs, notify, onOpen, onCreate, onMultiLogs }: {
  refreshMs: number; notify: Notify; onOpen: (c: ContainerRow, tab?: 'logs' | 'shell') => void; onCreate: () => void; onMultiLogs: (ids: string[]) => void
}) {
  const { data, error, refresh, loading } = usePoll((q) => api.containers.list(q), refreshMs)
  const [stats, setStats] = useState<Record<string, StatsRow>>({})
  const [query, setQuery] = useState('')
  const [onlyRunning, setOnlyRunning] = useState(false)
  const [project, setProject] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ kind: 'commit' | 'cp' | 'export'; c: ContainerRow } | null>(null)

  // stats só quando há containers a correr (comando pesado no PC lento → intervalo maior)
  useEffect(() => {
    const anyRunning = (data ?? []).some((c) => c.state === 'running')
    if (!anyRunning) { setStats({}); return }
    let stop = false
    const load = (): void => { void api.containers.stats().then((rows) => { if (!stop) setStats(Object.fromEntries(rows.map((r) => [r.id.slice(0, 12), r]))) }).catch(() => {}) }
    load()
    const t = setInterval(load, Math.max(refreshMs || 10000, 10000))
    return () => { stop = true; clearInterval(t) }
  }, [data, refreshMs])
  useEffect(() => { const close = (): void => setMenu(null); window.addEventListener('click', close); return () => window.removeEventListener('click', close) }, [])

  const projects = useMemo(() => [...new Set((data ?? []).map((c) => c.labels['com.docker.compose.project'] || c.labels['io.podman.compose.project'] || c.labels.project || '').filter(Boolean))], [data])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (data ?? []).filter((c) => (!onlyRunning || c.state === 'running') && (!project || [c.labels['com.docker.compose.project'], c.labels['io.podman.compose.project'], c.labels.project].includes(project)) &&
      (!q || `${c.name} ${c.image} ${Object.entries(c.labels).map(([k, v]) => `${k}=${v}`).join(' ')}`.toLowerCase().includes(q)))
  }, [data, query, onlyRunning, project])
  const running = (data ?? []).filter((c) => c.state === 'running').length

  const act = async (c: ContainerRow, action: string, force = false): Promise<void> => {
    if (action === 'remove' && !confirm(`Remover o container ${c.name}?${c.state === 'running' ? ' Está a correr — será parado.' : ''}`)) return
    setBusy(c.id)
    try { await api.containers.action(c.name, action, force); notify(`${c.name}: ${action} ✓`, 'success'); await refresh() } catch (e) { notify(errMsg(e), 'error') } finally { setBusy(null) }
  }
  const batch = async (action: string): Promise<void> => {
    const names = (data ?? []).filter((c) => sel.has(c.id)).map((c) => c.name)
    if (!names.length) return
    if (action === 'remove' && !confirm(`Remover ${names.length} container(s)?`)) return
    setBusy('batch')
    try {
      const r = await api.containers.batch(names, action, action === 'remove')
      const failed = Object.entries(r).filter(([, v]) => v.startsWith('✗'))
      notify(failed.length ? `${action}: ${failed.length} falharam — ${failed.map(([k, v]) => `${k}: ${v}`).join('; ')}` : `${action} em ${names.length} container(s) ✓`, failed.length ? 'error' : 'success')
      setSel(new Set())
      await refresh()
    } catch (e) { notify(errMsg(e), 'error') } finally { setBusy(null) }
  }
  const toggle = (id: string): void => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const allSel = shown.length > 0 && shown.every((c) => sel.has(c.id))
  const cols = '36px 24px 220px minmax(0,1fr) 150px 190px 120px 90px 250px'

  return (
    <div className="page">
      <PageHeader title="Containers" count={`${running} a correr · ${(data ?? []).length - running} parados`} onRefresh={() => void refresh()} loading={loading}>
        <label className="search" style={{ width: 280 }}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input placeholder="filtrar por nome, imagem, label…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label className="inline"><input type="checkbox" checked={onlyRunning} onChange={(e) => setOnlyRunning(e.target.checked)} /> só a correr</label>
        {projects.length > 0 && (
          <select className="input" value={project} onChange={(e) => setProject(e.target.value)}><option value="">todos os projetos</option>{projects.map((p) => <option key={p} value={p}>{p}</option>)}</select>
        )}
        <button className="btn btn-primary" onClick={onCreate}>＋ Novo container</button>
      </PageHeader>

      <div className="row small muted">
        <span>{sel.size} selecionado(s):</span>
        <button className="btn btn-sm" disabled={!sel.size || !!busy} onClick={() => void batch('start')}>▶ Start</button>
        <button className="btn btn-sm" disabled={!sel.size || !!busy} onClick={() => void batch('stop')}>■ Stop</button>
        <button className="btn btn-sm" disabled={!sel.size || !!busy} onClick={() => void batch('restart')}>⟳ Restart</button>
        <button className="btn btn-sm btn-danger" disabled={!sel.size || !!busy} onClick={() => void batch('remove')}>Remove</button>
        <button className="btn btn-sm" disabled={!sel.size} onClick={() => onMultiLogs((data ?? []).filter((c) => sel.has(c.id)).map((c) => c.name))} title="logs dos selecionados em conjunto">▤ Logs em conjunto</button>
        <span className="grow" />
        <button className="btn btn-sm" disabled={!!busy} onClick={() => { if (confirm('Remover todos os containers parados?')) void api.containers.prune().then((r) => { notify(r.stdout.trim() || 'feito', 'success'); void refresh() }).catch((e) => notify(errMsg(e), 'error')) }}>Remover parados</button>
      </div>

      {error && <div className="text-error small">{error}</div>}
      <div className="table wide">
        <div className="thead" style={{ gridTemplateColumns: cols }}>
          <input type="checkbox" aria-label="selecionar todos" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(shown.map((c) => c.id)))} />
          <span /><span>Nome</span><span>Imagem</span><span>Estado</span><span>Portas</span><span>CPU / Mem</span><span>Health</span><span />
        </div>
        {shown.map((c) => {
          const up = c.state === 'running'
          const st = stats[c.id.slice(0, 12)]
          return (
            <div key={c.id} className={`tr${sel.has(c.id) ? ' selected' : ''}`} style={{ gridTemplateColumns: cols }}>
              <input type="checkbox" aria-label={`selecionar ${c.name}`} checked={sel.has(c.id)} onChange={() => toggle(c.id)} />
              <Dot state={c.state} />
              <div className="ellipsis">
                <button className="name-link" onClick={() => onOpen(c)} title={c.name}>{c.name}</button>
                <div className="dim tiny ellipsis">{c.id.slice(0, 12)}{c.networks.length ? ` · ${c.networks.join(', ')}` : ''}</div>
              </div>
              <span className="mono small ellipsis" title={c.image}>{c.image}</span>
              <span className="small"><b style={{ color: up ? 'var(--green)' : c.state === 'paused' ? 'var(--amber)' : 'var(--muted)' }}>{c.state}</b> <span className="dim">{c.status.replace(/\s*\((healthy|unhealthy|starting)\)/, '')}</span></span>
              <span className="mono small ellipsis" style={{ color: up ? 'var(--accent)' : 'var(--dim)' }} title={c.ports.join(', ')}>{c.ports.join(' · ') || '—'}</span>
              <span className="mono small">{st ? `${st.cpu} · ${st.mem.split('/')[0].trim()}` : up ? '…' : '—'}</span>
              <span>{c.health ? <Pill tone={c.health === 'healthy' ? 'green' : c.health === 'unhealthy' ? 'red' : 'amber'}>{c.health}</Pill> : <span className="dim tiny">—</span>}</span>
              <div className="actions">
                {up ? (
                  <>
                    <button className="btn btn-sm" disabled={busy === c.id} onClick={() => onOpen(c, 'logs')}>Logs</button>
                    <button className="btn btn-sm" disabled={busy === c.id} onClick={() => onOpen(c, 'shell')}>&gt;_ Shell</button>
                    <button className="btn btn-sm" disabled={busy === c.id} onClick={() => void act(c, 'restart')} title="restart">⟳</button>
                    <button className="btn btn-sm btn-danger" disabled={busy === c.id} onClick={() => void act(c, 'stop')} title="stop">■</button>
                  </>
                ) : (
                  <>
                    <button className="btn btn-sm btn-primary" disabled={busy === c.id} onClick={() => void act(c, c.state === 'paused' ? 'unpause' : 'start')}>▶ {c.state === 'paused' ? 'Unpause' : 'Start'}</button>
                    <button className="btn btn-sm" disabled={busy === c.id} onClick={() => onOpen(c, 'logs')}>Logs</button>
                    <button className="btn btn-sm btn-danger" disabled={busy === c.id} onClick={() => void act(c, 'remove', true)}>Remove</button>
                  </>
                )}
                <div className="menu-wrap">
                  <button className="btn btn-sm" aria-label="mais" onClick={(e) => { e.stopPropagation(); setMenu(menu === c.id ? null : c.id) }}>⋯</button>
                  {menu === c.id && (
                    <div className="menu" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => { setMenu(null); onOpen(c) }}>Inspect (env, mounts, rede)</button>
                      {up && <button onClick={() => { setMenu(null); void act(c, 'pause') }}>Pause</button>}
                      <button onClick={() => { setMenu(null); setDialog({ kind: 'cp', c }) }}>Copiar ficheiros de/para…</button>
                      <button onClick={() => { setMenu(null); setDialog({ kind: 'commit', c }) }}>Commit para imagem…</button>
                      <button onClick={() => { setMenu(null); setDialog({ kind: 'export', c }) }}>Export .tar…</button>
                      <button onClick={() => { setMenu(null); void navigator.clipboard.writeText(c.name).then(() => notify('nome copiado', 'info')) }}>Copiar nome</button>
                      <div className="sep" />
                      {up && <button style={{ color: 'var(--red)' }} onClick={() => { setMenu(null); void act(c, 'kill') }}>Kill (SIGKILL)</button>}
                      <button style={{ color: 'var(--red)' }} onClick={() => { setMenu(null); void act(c, 'remove', true) }}>Remove (forçado)</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
        {data && !shown.length && <div className="tr muted" style={{ gridTemplateColumns: '1fr' }}>{onlyRunning ? 'Nenhum container a correr.' : query ? 'Nada corresponde ao filtro.' : 'Nenhum container.'}</div>}
        {!data && !error && <div className="tr muted" style={{ gridTemplateColumns: '1fr' }}>A carregar…</div>}
      </div>

      {dialog && <ContainerDialog kind={dialog.kind} c={dialog.c} notify={notify} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void refresh() }} />}
    </div>
  )
}

function ContainerDialog({ kind, c, notify, onClose, onDone }: { kind: 'commit' | 'cp' | 'export'; c: ContainerRow; notify: Notify; onClose: () => void; onDone: () => void }) {
  const [a, setA] = useState(kind === 'commit' ? `${c.name}:snapshot` : kind === 'export' ? '' : '')
  const [b, setB] = useState('')
  const [dir, setDir] = useState<'out' | 'in'>('out')
  const [busy, setBusy] = useState(false)
  const go = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = kind === 'commit' ? await api.containers.commit(c.name, a) : kind === 'export' ? await api.containers.export(c.name, a || undefined) : await api.containers.cp(c.name, dir, a, b)
      if (r.code) notify(r.stderr.trim() || 'falhou', 'error'); else { notify(`${kind} ✓ ${r.stdout.trim().slice(0, 80)}`, 'success'); onDone() }
    } catch (e) { notify(errMsg(e), 'error') } finally { setBusy(false) }
  }
  return (
    <Modal title={kind === 'commit' ? `Commit ${c.name} para imagem` : kind === 'export' ? `Export ${c.name} (.tar)` : `Copiar ficheiros — ${c.name}`} onClose={onClose}>
      {kind === 'commit' && <label className="col">Tag da nova imagem<input className="input mono" value={a} onChange={(e) => setA(e.target.value)} placeholder="nome:tag" /></label>}
      {kind === 'export' && <label className="col">Ficheiro de destino (vazio = pasta de dados da app)<input className="input mono" value={a} onChange={(e) => setA(e.target.value)} placeholder="C:\temp\container.tar" /></label>}
      {kind === 'cp' && (
        <>
          <label className="inline">Direção <select className="input sm" value={dir} onChange={(e) => setDir(e.target.value as 'in' | 'out')}><option value="out">container → host</option><option value="in">host → container</option></select></label>
          <label className="col">{dir === 'out' ? 'Caminho no container' : 'Caminho no host'}<input className="input mono" value={a} onChange={(e) => setA(e.target.value)} placeholder={dir === 'out' ? '/app/logs' : 'C:\\temp\\config.yml'} /></label>
          <label className="col">{dir === 'out' ? 'Destino no host' : 'Destino no container'}<input className="input mono" value={b} onChange={(e) => setB(e.target.value)} placeholder={dir === 'out' ? 'C:\\temp' : '/app/config.yml'} /></label>
        </>
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>Cancelar</button><button className="btn btn-primary" disabled={busy || (kind !== 'export' && !a.trim()) || (kind === 'cp' && !b.trim())} onClick={() => void go()}>{busy ? 'A correr…' : 'OK'}</button></div>
    </Modal>
  )
}
