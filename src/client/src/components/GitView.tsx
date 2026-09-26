import { useCallback, useEffect, useState } from 'react'
import type { GitBranch, GitChange, GitCommit, GitInfo, ServiceInfo } from '../../../shared/types'
import { api } from '../api'
import { Badge } from './common'

type Notify = (t: string, k?: 'error' | 'info' | 'success') => void
const CODE_LABEL: Record<string, string> = { M: 'modificado', A: 'novo', D: 'apagado', R: 'renomeado', C: 'copiado', U: 'conflito', '?': 'não seguido', T: 'tipo' }

export function GitView({ svc, notify, fail, onChanged }: { svc: ServiceInfo; notify: Notify; fail: (e: unknown) => void; onChanged?: () => Promise<void> }) {
  const [info, setInfo] = useState<GitInfo | null>(null)
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [log, setLog] = useState<GitCommit[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [sel, setSel] = useState<GitChange | null>(null)
  const [diff, setDiff] = useState<string>('')
  const [newBranch, setNewBranch] = useState('')
  const [checkoutTarget, setCheckoutTarget] = useState('')
  const [message, setMessage] = useState('')
  const [showRemote, setShowRemote] = useState(false)
  const [tab, setTab] = useState<'changes' | 'branches' | 'log'>('changes')

  const load = useCallback(async () => {
    try {
      const i = await api.git.info(svc.id)
      setInfo(i)
      if (i.isRepo) {
        const [b, l] = await Promise.all([api.git.branches(svc.id), api.git.log(svc.id)])
        setBranches(b)
        setLog(l)
        setCheckoutTarget((cur) => cur || i.branch || '')
      }
    } catch (e) {
      fail(e)
    }
  }, [svc.id, fail])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!sel) {
      setDiff('')
      return
    }
    let cancelled = false
    api.git.diff(svc.id, sel.repoPath, sel.staged && !sel.unstaged, sel.untracked)
      .then((d) => !cancelled && setDiff(d || '(sem diferenças de texto — ficheiro binário ou vazio)'))
      .catch((e) => !cancelled && setDiff(`erro: ${e instanceof Error ? e.message : e}`))
    return () => {
      cancelled = true
    }
  }, [sel, svc.id])

  const act = async (label: string, fn: () => Promise<unknown>, done?: string | ((r: unknown) => string)): Promise<void> => {
    setBusy(label)
    try {
      const r = await fn()
      if (done) notify(typeof done === 'function' ? done(r) : done, 'success')
      setSel(null)
      await load()
      await onChanged?.()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  if (!info) return <div className="empty">A ler estado do git…</div>
  if (!info.isRepo) {
    return (
      <div className="empty">
        <p>{info.error ?? 'Esta pasta não está num repositório git.'}</p>
        <p className="muted small mono">{svc.path}</p>
      </div>
    )
  }

  const staged = info.changes.filter((c) => c.staged)
  const unstaged = info.changes.filter((c) => c.unstaged)
  const local = branches.filter((b) => !b.remote)
  const remote = branches.filter((b) => b.remote)
  const trimmed = (s: string): string => s.replace(/^\s+/, '')

  return (
    <div className="config git">
      <section>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 16, margin: 0 }} title={[info.root, info.upstream ? `upstream ${info.upstream}` : 'sem upstream', info.remote ? `origin ${info.remote}` : ''].filter(Boolean).join(' · ')}>
            ⎇ {info.branch ?? '?'}{info.detached && <Badge tone="amber">detached</Badge>}
          </h2>
          {info.upstream && !!info.behind && <Badge tone="amber" title="commits no remoto por trazer (Pull)">↓ {info.behind}</Badge>}
          {info.upstream && !!info.ahead && <Badge tone="blue" title="commits locais por enviar (Push)">↑ {info.ahead}</Badge>}
          <span className="grow" />
          <button className="btn btn-sm" disabled={!!busy} onClick={() => act('fetch', () => api.git.fetch(svc.id), 'Fetch feito')}>{busy === 'fetch' ? '…' : 'Fetch'}</button>
          <button className="btn btn-sm" disabled={!!busy || !info.upstream} onClick={() => act('pull', () => api.git.pull(svc.id), (r) => trimmed(String(r)).split('\n')[0] || 'Pull feito')} title="git pull --ff-only">Pull{info.behind ? ` ↓${info.behind}` : ''}</button>
          <button className="btn btn-sm btn-primary" disabled={!!busy || (!info.ahead && !!info.upstream)} title={info.upstream ? 'git push' : `git push -u origin ${info.branch}`}
            onClick={() => { if (confirm(`Enviar ${info.branch} para ${info.remote ?? 'origin'}?`)) void act('push', () => api.git.push(svc.id), (r) => trimmed(String(r)).split('\n')[0] || 'Push feito') }}>Push{info.ahead ? ` ↑${info.ahead}` : ''}</button>
          <button className="btn btn-sm" disabled={!!busy} onClick={() => load()} title="atualizar">⟳</button>
        </div>
      </section>

      <div className="tabs inline">
        <button className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}>Alterações {info.changes.length ? <span className="count">{info.changes.length}</span> : null}</button>
        <button className={tab === 'branches' ? 'active' : ''} onClick={() => setTab('branches')}>Branches <span className="count">{local.length}</span></button>
        <button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>Histórico</button>
      </div>

      {tab === 'changes' && (
        <>
          <section>
            <div className="row">
              <h3 className="grow">Alterações {info.changes.length ? `(${staged.length} preparadas, ${unstaged.length} por preparar)` : ''}</h3>
              <button className="btn btn-sm" disabled={!!busy || !unstaged.length} onClick={() => act('stage', () => api.git.stage(svc.id, unstaged.map((c) => c.repoPath)))}>Preparar tudo</button>
              <button className="btn btn-sm" disabled={!!busy || !staged.length} onClick={() => act('unstage', () => api.git.unstage(svc.id, staged.map((c) => c.repoPath)))}>Despreparar tudo</button>
            </div>
            <p className="muted small">Alterações por commitar na pasta de trabalho — não pertencem a nenhuma branch até fazeres commit; ao mudar de branch acompanham-te.</p>
            {!info.changes.length && <p className="muted">Sem alterações — a árvore está limpa.</p>}
            {info.changes.length > 0 && (
              <table className="grid">
                <thead><tr><th>Prep.</th><th>Ficheiro</th><th>Estado</th><th></th></tr></thead>
                <tbody>
                  {info.changes.map((c) => (
                    <tr key={c.repoPath} className={sel?.repoPath === c.repoPath ? 'selected-row' : ''}>
                      <td>
                        <input type="checkbox" checked={c.staged && !c.unstaged} disabled={!!busy} title={c.staged ? 'despreparar' : 'preparar (git add)'}
                          onChange={(e) => act('stage1', () => (e.target.checked ? api.git.stage(svc.id, [c.repoPath]) : api.git.unstage(svc.id, [c.repoPath])))} />
                      </td>
                      <td className="mono small"><a className="link" onClick={() => setSel(c)}>{c.origPath ? `${c.origPath} → ` : ''}{c.path}</a></td>
                      <td className="small">
                        <Badge tone={c.untracked ? 'purple' : c.code === 'D' ? 'red' : c.code === 'A' ? 'green' : 'amber'}>{CODE_LABEL[c.code] ?? c.code}</Badge>
                        {c.staged && c.unstaged ? <span className="muted"> (parcialmente preparado)</span> : ''}
                      </td>
                      <td className="cell-actions">
                        <button className="btn btn-sm" onClick={() => setSel(c)}>Diff</button>
                        <button className="btn btn-sm btn-danger" disabled={!!busy}
                          onClick={() => { if (confirm(c.untracked ? `Apagar o ficheiro não seguido ${c.path}?` : `Descartar as alterações em ${c.path}? (volta ao último commit)`)) void act('discard', () => api.git.discard(svc.id, [{ repoPath: c.repoPath, untracked: c.untracked }]), `${c.path} descartado`) }}>Descartar</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {sel && (
              <div>
                <div className="row"><span className="mono small grow">{sel.path} {sel.staged && !sel.unstaged ? '(preparado)' : ''}</span><button className="btn btn-sm" onClick={() => setSel(null)}>Fechar</button></div>
                <pre className="resp-body diff">{diff.split('\n').map((l, i) => <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'diff-add' : l.startsWith('-') && !l.startsWith('---') ? 'diff-del' : l.startsWith('@@') ? 'diff-hunk' : ''}>{l || ' '}</div>)}</pre>
              </div>
            )}
          </section>
          <section>
            <h3>Commit</h3>
            <div className="row">
              <input className="input grow" placeholder="mensagem do commit" value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && message.trim() && staged.length) void act('commit', () => api.git.commit(svc.id, message, false), () => { setMessage(''); return 'Commit feito' }) }} />
              <button className="btn btn-primary" disabled={!!busy || !message.trim() || !staged.length} onClick={() => act('commit', () => api.git.commit(svc.id, message, false), () => { setMessage(''); return 'Commit feito' })}>Commit ({staged.length})</button>
              <button className="btn" disabled={!!busy || !message.trim() || !info.changes.length} title="git add -A (nesta pasta) + commit" onClick={() => act('commit', () => api.git.commit(svc.id, message, true), () => { setMessage(''); return 'Commit feito' })}>Preparar tudo + commit</button>
            </div>
          </section>
        </>
      )}

      {tab === 'branches' && (
        <>
          <section>
            <h3>Nova branch (a partir de {info.branch})</h3>
            <div className="row">
              <input className="input mono grow" placeholder="feature/nome" value={newBranch} onChange={(e) => setNewBranch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && newBranch.trim() && act('branch', () => api.git.createBranch(svc.id, newBranch), () => { setNewBranch(''); return `Branch ${newBranch} criada e ativa` })} />
              <button className="btn btn-primary" disabled={!!busy || !newBranch.trim()} onClick={() => act('branch', () => api.git.createBranch(svc.id, newBranch), () => { setNewBranch(''); return `Branch ${newBranch} criada e ativa` })}>Criar e mudar</button>
            </div>
            {info.changes.length > 0 && <p className="muted small">As alterações por commitar acompanham-te para a branch nova.</p>}
          </section>
          <section>
            <div className="row">
              <h3 className="grow">Branches</h3>
              <label className="check"><input type="checkbox" checked={showRemote} onChange={(e) => setShowRemote(e.target.checked)} /> mostrar remotas ({remote.length})</label>
            </div>
            <table className="grid">
              <thead><tr><th>Branch</th><th>Upstream</th><th>Último commit</th><th></th></tr></thead>
              <tbody>
                {[...local, ...(showRemote ? remote : [])].map((b) => (
                  <tr key={b.name}>
                    <td className="mono">{b.current ? <b>⎇ {b.name}</b> : b.name}{b.remote && <Badge>remota</Badge>}</td>
                    <td className="mono small muted">{b.upstream ?? ''}</td>
                    <td className="small muted">{b.when}{b.subject ? ` — ${b.subject}` : ''}</td>
                    <td className="cell-actions">
                      {!b.current && (
                        <button className="btn btn-sm" disabled={!!busy} onClick={() => act('checkout', () => api.git.checkout(svc.id, b.name), `Agora em ${b.name.replace(/^(origin|upstream)\//, '')}`)}>Mudar para</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

      {tab === 'log' && (
        <section>
          <h3>Últimos commits {info.prefix ? '(que tocam nesta pasta)' : ''}</h3>
          <table className="grid">
            <tbody>
              {log.map((c) => (
                <tr key={c.hash}>
                  <td className="mono small">{c.hash}</td>
                  <td>{c.subject}{c.refs && <span className="muted small"> ({c.refs})</span>}</td>
                  <td className="small muted">{c.author}, {c.when}</td>
                </tr>
              ))}
              {!log.length && <tr><td className="muted">Sem commits.</td></tr>}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
