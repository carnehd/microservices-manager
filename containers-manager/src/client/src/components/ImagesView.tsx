import { useMemo, useState } from 'react'
import type { ImageLayer, ImageRow } from '../../../shared/types'
import { api } from '../api'
import { fmtAgo, fmtBytes, usePoll, useStream } from '../hooks'
import { ConsoleOut, Modal, PageHeader, Pill, errMsg, execText, type Notify } from './common'

export function ImagesView({ refreshMs, notify, onRunImage }: { refreshMs: number; notify: Notify; onRunImage: (ref: string) => void }) {
  const { data, error, refresh, loading } = usePoll((q) => api.images.list(q), refreshMs * 3)
  const [query, setQuery] = useState('')
  const [ref, setRef] = useState('')
  const [streamId, setStreamId] = useState<string | null>(null)
  const { lines, ended } = useStream(streamId, 400)
  const [busy, setBusy] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ kind: 'tag' | 'save' | 'layers' | 'load' | 'build'; img?: ImageRow } | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())

  const shown = useMemo(() => (data ?? []).filter((i) => !query || `${i.repoTags.join(' ')} ${i.id}`.toLowerCase().includes(query.toLowerCase())), [data, query])
  const total = (data ?? []).reduce((a, i) => a + i.size, 0)
  const reclaim = (data ?? []).filter((i) => !i.containers).reduce((a, i) => a + i.size, 0)

  const pull = async (): Promise<void> => {
    const r = ref.trim(); if (!r) return
    try { const s = await api.images.pull(r); setStreamId(s.stream) } catch (e) { notify(errMsg(e), 'error') }
  }
  const exec = async (label: string, fn: () => Promise<{ stdout: string; stderr: string; code: number }>): Promise<void> => {
    setBusy(label)
    try { const r = await fn(); if (r.code) notify(r.stderr.trim().split('\n').pop() || 'falhou', 'error'); else notify(`${label} ✓`, 'success'); await refresh() } catch (e) { notify(errMsg(e), 'error') } finally { setBusy(null) }
  }
  const removeSel = async (): Promise<void> => {
    const ids = [...sel]; if (!ids.length || !confirm(`Remover ${ids.length} imagem(ns)?`)) return
    for (const id of ids) await exec(`rmi ${id}`, () => api.images.remove(id))
    setSel(new Set())
  }
  // progresso do pull: linhas "Copying blob abc done" / "Copying blob abc [=====>  ] 12MiB / 30MiB"
  const progress = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of lines) { const mm = /Copying (blob|config) (\w+)\s*(.*)/.exec(l.text); if (mm) m.set(mm[2].slice(0, 12), mm[3] || '…') }
    return [...m.entries()]
  }, [lines])
  const cols = '36px minmax(0,1fr) 120px 90px 110px 150px 290px'

  return (
    <div className="page">
      <PageHeader title="Images" count={`${(data ?? []).length} imagens · ${fmtBytes(total)} · ${fmtBytes(reclaim)} sem containers`} onRefresh={() => void refresh()} loading={loading}>
        <label className="search" style={{ width: 240 }}><input placeholder="filtrar…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <button className="btn" onClick={() => setDialog({ kind: 'load' })}>⤒ Load .tar</button>
        <button className="btn" onClick={() => setDialog({ kind: 'build' })}>🔨 Build (Dockerfile)</button>
        <button className="btn btn-warn" disabled={!!busy} onClick={() => { if (confirm('Remover imagens dangling (sem tag)?')) void exec('prune', () => api.images.prune(false)) }}>Prune dangling</button>
      </PageHeader>

      <div className="card">
        <div className="row">
          <b>Pull</b>
          <input className="input mono grow" style={{ minWidth: 320 }} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="docker.io/library/postgres:17-alpine" onKeyDown={(e) => { if (e.key === 'Enter') void pull() }} />
          <button className="btn btn-primary" disabled={!ref.trim() || (!!streamId && ended === undefined)} onClick={() => void pull()}>⤓ Pull</button>
          {streamId && ended === undefined && <button className="btn btn-sm" onClick={() => void api.stopStream(streamId)}>Cancelar</button>}
        </div>
        {streamId && (
          <>
            {progress.length > 0 && (
              <div className="kv" style={{ gridTemplateColumns: '110px minmax(0,1fr)' }}>
                {progress.map(([id, st]) => <span key={id} style={{ display: 'contents' }}><span className="mono tiny muted">{id}{st.includes('done') ? ' ✓' : ''}</span><div className="progress"><div style={{ width: st.includes('done') ? '100%' : (/(\d+(?:\.\d+)?)\s*(\w+) \/ (\d+(?:\.\d+)?)\s*(\w+)/.exec(st) ? `${Math.min(100, (parseFloat(RegExp.$1) / Math.max(0.1, parseFloat(RegExp.$3))) * 100)}%` : '30%'), background: st.includes('done') ? 'var(--green)' : undefined }} /></div></span>)}
              </div>
            )}
            <ConsoleOut text={lines.slice(-12).map((l) => l.text).join('\n')} style={{ maxHeight: 180 }} />
            {ended !== undefined && <div className={ended === 0 ? 'text-ok small' : 'text-error small'}>{ended === 0 ? 'Pull concluído' : `Pull falhou (exit ${ended}) — registo bloqueado pelo proxy? usa um espelho interno ou Load .tar`} <button className="link small" onClick={() => { setStreamId(null); void refresh() }}>fechar</button></div>}
          </>
        )}
      </div>

      {error && <div className="text-error small">{error}</div>}
      <div className="row small muted"><span>{sel.size} selecionada(s):</span><button className="btn btn-sm btn-danger" disabled={!sel.size || !!busy} onClick={() => void removeSel()}>Remove</button></div>
      <div className="table wide">
        <div className="thead" style={{ gridTemplateColumns: cols }}><input type="checkbox" aria-label="todas" checked={shown.length > 0 && shown.every((i) => sel.has(i.id))} onChange={() => setSel(shown.every((i) => sel.has(i.id)) ? new Set() : new Set(shown.map((i) => i.id)))} /><span>Imagem</span><span>ID</span><span>Tamanho</span><span>Criada</span><span>Usada por</span><span /></div>
        {shown.map((i) => {
          const main = i.repoTags[0]
          return (
            <div key={i.id} className={`tr${sel.has(i.id) ? ' selected' : ''}`} style={{ gridTemplateColumns: cols, background: i.dangling ? 'rgba(240,180,41,.05)' : undefined }}>
              <input type="checkbox" aria-label="selecionar" checked={sel.has(i.id)} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(i.id)) n.delete(i.id); else n.add(i.id); return n })} />
              <div className="mono small ellipsis">
                {i.repoTags.length ? i.repoTags.map((t) => { const k = t.lastIndexOf(':'); return <div key={t} className="ellipsis">{k > 0 ? <>{t.slice(0, k)}<span style={{ color: 'var(--accent)' }}>{t.slice(k)}</span></> : t}</div> }) : <span className="muted">&lt;none&gt; <Pill tone="amber">dangling</Pill></span>}
              </div>
              <span className="mono small muted">{i.id}</span>
              <span className="small">{fmtBytes(i.size)}</span>
              <span className="small muted">{fmtAgo(i.created)}</span>
              <span className="small" style={{ color: i.containers ? 'var(--green)' : 'var(--dim)' }}>{i.containers ? `${i.containers} container(s)` : '—'}</span>
              <div className="actions">
                {main && <button className="btn btn-sm" onClick={() => onRunImage(main)}>▶ Run…</button>}
                <button className="btn btn-sm" onClick={() => setDialog({ kind: 'layers', img: i })}>Camadas</button>
                <button className="btn btn-sm" onClick={() => setDialog({ kind: 'tag', img: i })}>Tag</button>
                <button className="btn btn-sm" onClick={() => setDialog({ kind: 'save', img: i })}>Save .tar</button>
                <button className="btn btn-sm btn-danger" disabled={!!i.containers || !!busy} title={i.containers ? 'em uso por containers' : 'remover'} onClick={() => { if (confirm(`Remover ${main ?? i.id}?`)) void exec(`rmi ${i.id}`, () => api.images.remove(i.id)) }}>Remove</button>
              </div>
            </div>
          )
        })}
        {data && !shown.length && <div className="tr muted" style={{ gridTemplateColumns: '1fr' }}>Nenhuma imagem.</div>}
      </div>

      {dialog?.kind === 'tag' && dialog.img && <TagDialog img={dialog.img} onClose={() => setDialog(null)} onDone={(t) => void exec(`tag ${t}`, () => api.images.tag(dialog.img!.id, t)).then(() => setDialog(null))} />}
      {dialog?.kind === 'save' && dialog.img && <SaveDialog img={dialog.img} onClose={() => setDialog(null)} onDone={(f) => void exec('save', () => api.images.save(dialog.img!.id, dialog.img!.repoTags[0], f || undefined)).then(() => setDialog(null))} />}
      {dialog?.kind === 'layers' && dialog.img && <LayersDialog img={dialog.img} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'load' && <LoadDialog onClose={() => setDialog(null)} onDone={(f) => void exec('load', () => api.images.load(f)).then(() => setDialog(null))} />}
      {dialog?.kind === 'build' && <BuildDialog notify={notify} onClose={() => { setDialog(null); void refresh() }} />}
    </div>
  )
}

function TagDialog({ img, onClose, onDone }: { img: ImageRow; onClose: () => void; onDone: (t: string) => void }) {
  const [t, setT] = useState(img.repoTags[0] ?? '')
  return <Modal title="Nova tag" onClose={onClose}><label className="col">Tag (nome:versão)<input className="input mono" value={t} onChange={(e) => setT(e.target.value)} autoFocus /></label><div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>Cancelar</button><button className="btn btn-primary" disabled={!t.trim()} onClick={() => onDone(t.trim())}>Tag</button></div></Modal>
}
function SaveDialog({ img, onClose, onDone }: { img: ImageRow; onClose: () => void; onDone: (f: string) => void }) {
  const [f, setF] = useState('')
  return <Modal title={`Save ${img.repoTags[0] ?? img.id} (.tar)`} onClose={onClose}><label className="col">Ficheiro de destino (vazio = pasta de dados da app)<input className="input mono" value={f} onChange={(e) => setF(e.target.value)} placeholder="C:\temp\imagem.tar" autoFocus /></label><p className="muted small">Útil para levar imagens para um PC onde o registo está bloqueado: lá, usa <b>Load .tar</b>.</p><div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>Cancelar</button><button className="btn btn-primary" onClick={() => onDone(f.trim())}>Save</button></div></Modal>
}
function LoadDialog({ onClose, onDone }: { onClose: () => void; onDone: (f: string) => void }) {
  const [f, setF] = useState('')
  return <Modal title="Load imagem de .tar" onClose={onClose}><label className="col">Ficheiro .tar no host<input className="input mono" value={f} onChange={(e) => setF(e.target.value)} placeholder="C:\temp\imagem.tar" autoFocus /></label><div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>Cancelar</button><button className="btn btn-primary" disabled={!f.trim()} onClick={() => onDone(f.trim())}>Load</button></div></Modal>
}
function LayersDialog({ img, onClose }: { img: ImageRow; onClose: () => void }) {
  const { data, error } = usePoll(() => api.images.history(img.id), 0, [img.id])
  return (
    <Modal title={`Camadas — ${img.repoTags[0] ?? img.id}`} onClose={onClose} width={860}>
      {error && <div className="text-error small">{error}</div>}
      {!data && !error && <div className="muted">A carregar…</div>}
      {data && (
        <div className="table"><div className="thead" style={{ gridTemplateColumns: '100px 90px minmax(0,1fr)' }}><span>ID</span><span>Tamanho</span><span>Criada por</span></div>
          {data.map((l: ImageLayer, i) => <div key={i} className="tr" style={{ gridTemplateColumns: '100px 90px minmax(0,1fr)', minHeight: 34 }}><span className="mono tiny muted">{l.id || '<missing>'}</span><span className="small">{fmtBytes(l.size)}</span><span className="mono tiny" style={{ wordBreak: 'break-all' }}>{l.createdBy.replace(/^\/bin\/sh -c (#\(nop\) )?/, '')}</span></div>)}
        </div>
      )}
    </Modal>
  )
}
function BuildDialog({ notify, onClose }: { notify: Notify; onClose: () => void }) {
  const [ctx, setCtx] = useState('')
  const [tag, setTag] = useState('')
  const [df, setDf] = useState('')
  const [streamId, setStreamId] = useState<string | null>(null)
  const { lines, ended } = useStream(streamId, 2000)
  const start = async (): Promise<void> => { try { const r = await api.images.build(ctx.trim(), tag.trim(), df.trim() || undefined); setStreamId(r.stream) } catch (e) { notify(errMsg(e), 'error') } }
  return (
    <Modal title="Build a partir de Dockerfile" onClose={onClose} width={820}>
      <div className="form-grid">
        <label className="col">Pasta de contexto<input className="input mono" value={ctx} onChange={(e) => setCtx(e.target.value)} placeholder="C:\projetos\ms-cliente" /></label>
        <label className="col">Tag<input className="input mono" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="ms-cliente:dev" /></label>
        <label className="col">Dockerfile (vazio = ./Dockerfile)<input className="input mono" value={df} onChange={(e) => setDf(e.target.value)} placeholder="docker/Dockerfile" /></label>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>Fechar</button><button className="btn btn-primary" disabled={!ctx.trim() || !tag.trim() || (!!streamId && ended === undefined)} onClick={() => void start()}>🔨 Build</button></div>
      {streamId && <ConsoleOut text={lines.map((l) => l.text).join('\n')} style={{ maxHeight: 320 }} />}
      {ended !== undefined && <div className={ended === 0 ? 'text-ok small' : 'text-error small'}>{ended === 0 ? 'Build concluído' : `Build falhou (exit ${ended})`}</div>}
    </Modal>
  )
}

export { execText }
