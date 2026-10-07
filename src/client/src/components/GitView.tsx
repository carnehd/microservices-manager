import { useCallback, useEffect, useState } from 'react'
import type { GitBranch, GitChange, GitCommit, GitInfo, GitStash, ServiceInfo } from '../../../shared/types'
import { api } from '../api'
import { Badge } from './common'

type Notify = (t: string, k?: 'error' | 'info' | 'success') => void
const CODE_LABEL: Record<string, string> = { M: 'modified', A: 'new', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', '?': 'untracked', T: 'type' }

export function GitView({ svc, notify, fail, onChanged }: { svc: ServiceInfo; notify: Notify; fail: (e: unknown) => void; onChanged?: () => Promise<void> }) {
  const [info, setInfo] = useState<GitInfo | null>(null)
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [log, setLog] = useState<GitCommit[]>([])
  const [stashes, setStashes] = useState<GitStash[]>([])
  const [stashMsg, setStashMsg] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [sel, setSel] = useState<GitChange | null>(null)
  const [diff, setDiff] = useState<string>('')
  const [newBranch, setNewBranch] = useState('')
  // Ramo de onde o novo branch é copiado; por omissão origin/main (senão origin/master, senão o ramo atual).
  const [fromBranch, setFromBranch] = useState('')
  const [checkoutTarget, setCheckoutTarget] = useState('')
  const [message, setMessage] = useState('')
  const [showRemote, setShowRemote] = useState(false)
  const [tab, setTab] = useState<'changes' | 'branches' | 'log'>('changes')

  const load = useCallback(async () => {
    try {
      const i = await api.git.info(svc.id)
      setInfo(i)
      if (i.isRepo) {
        const [b, l, st] = await Promise.all([api.git.branches(svc.id), api.git.log(svc.id), api.git.stashes(svc.id).catch(() => [] as GitStash[])])
        setBranches(b)
        setLog(l)
        setStashes(st)
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
      .then((d) => !cancelled && setDiff(d || '(no text differences — binary or empty file)'))
      .catch((e) => !cancelled && setDiff(`error: ${e instanceof Error ? e.message : e}`))
    return () => {
      cancelled = true
    }
  }, [sel, svc.id])

  // Base do novo branch por omissão: origin/main → origin/master → ramo atual. (Hook: tem de ficar antes dos `return` abaixo.)
  useEffect(() => {
    if (fromBranch || !branches.length) return
    const names = branches.map((b) => b.name)
    setFromBranch(names.includes('origin/main') ? 'origin/main' : names.includes('origin/master') ? 'origin/master' : branches.find((b) => b.current)?.name ?? names[0])
  }, [branches, fromBranch])

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

  if (!info) return <div className="empty">Reading git status…</div>
  if (!info.isRepo) {
    return (
      <div className="empty">
        <p>{info.error ?? 'This folder is not in a git repository.'}</p>
        <p className="muted small mono">{svc.path}</p>
      </div>
    )
  }

  const staged = info.changes.filter((c) => c.staged)
  const unstaged = info.changes.filter((c) => c.unstaged)
  const local = branches.filter((b) => !b.remote)
  const remote = branches.filter((b) => b.remote)
  const createBranch = (): Promise<unknown> => act('branch', () => api.git.createBranch(svc.id, newBranch, fromBranch), () => { setNewBranch(''); return `Branch ${newBranch} created from ${fromBranch} and active` })
  const trimmed = (s: string): string => s.replace(/^\s+/, '')

  return (
    <div className="config git">
      <section>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 16, margin: 0 }} title={[info.root, info.upstream ? `upstream ${info.upstream}` : 'sem upstream', info.remote ? `origin ${info.remote}` : ''].filter(Boolean).join(' · ')}>
            ⎇ {info.branch ?? '?'}{info.detached && <Badge tone="amber">detached</Badge>}
          </h2>
          {info.upstream && !!info.behind && <Badge tone="amber" title="commits on the remote to pull (Pull)">↓ {info.behind}</Badge>}
          {info.upstream && !!info.ahead && <Badge tone="blue" title="local commits to push (Push)">↑ {info.ahead}</Badge>}
          <span className="grow" />
          <button className="btn btn-sm" disabled={!!busy} onClick={() => act('fetch', () => api.git.fetch(svc.id), 'Fetch done')}>{busy === 'fetch' ? '…' : 'Fetch'}</button>
          <button className="btn btn-sm" disabled={!!busy || !info.upstream} onClick={() => act('pull', () => api.git.pull(svc.id), (r) => trimmed(String(r)).split('\n')[0] || 'Pull done')} title="git pull --ff-only">Pull{info.behind ? ` ↓${info.behind}` : ''}</button>
          <button className="btn btn-sm btn-primary" disabled={!!busy || (!info.ahead && !!info.upstream)} title={info.upstream ? 'git push' : `git push -u origin ${info.branch}`}
            onClick={() => { if (confirm(`Push ${info.branch} to ${info.remote ?? 'origin'}?`)) void act('push', () => api.git.push(svc.id), (r) => trimmed(String(r)).split('\n')[0] || 'Push done') }}>Push{info.ahead ? ` ↑${info.ahead}` : ''}</button>
          <button className="btn btn-sm" disabled={!!busy} onClick={() => load()} title="refresh">⟳</button>
        </div>
      </section>

      <div className="tabs inline">
        <button className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}>Changes {info.changes.length ? <span className="count">{info.changes.length}</span> : null}</button>
        <button className={tab === 'branches' ? 'active' : ''} onClick={() => setTab('branches')}>Branches <span className="count">{local.length}</span></button>
        <button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>History</button>
      </div>

      {tab === 'changes' && (
        <>
          <section>
            <div className="row">
              <h3 className="grow">Changes {info.changes.length ? `(${staged.length} staged, ${unstaged.length} unstaged)` : ''}</h3>
              <button className="btn btn-sm" disabled={!!busy || !unstaged.length} onClick={() => act('stage', () => api.git.stage(svc.id, unstaged.map((c) => c.repoPath)))}>Stage all</button>
              <button className="btn btn-sm" disabled={!!busy || !staged.length} onClick={() => act('unstage', () => api.git.unstage(svc.id, staged.map((c) => c.repoPath)))}>Unstage all</button>
            </div>
            <p className="muted small">Uncommitted changes in the working folder — they belong to no branch until you commit; when you switch branches they come with you.</p>
            {info.changes.length > 0 && (
              <div className="row">
                <input className="input grow" placeholder="stash message (optional)" value={stashMsg} onChange={(e) => setStashMsg(e.target.value)} />
                <button className="btn btn-sm" disabled={!!busy} title="git stash push -u — puts all these changes (new files included) aside and leaves the tree clean; get them back with Apply/Pop below"
                  onClick={() => act('stash', () => api.git.stash(svc.id, stashMsg), () => { setStashMsg(''); return 'Changes stashed' })}>Stash changes</button>
              </div>
            )}
            {!info.changes.length && <p className="muted">No changes — the tree is clean.</p>}
            {info.changes.length > 0 && (
              <table className="grid">
                <thead><tr><th>Staged</th><th>File</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {info.changes.map((c) => (
                    <tr key={c.repoPath} className={sel?.repoPath === c.repoPath ? 'selected-row' : ''}>
                      <td>
                        <input type="checkbox" checked={c.staged && !c.unstaged} disabled={!!busy} title={c.staged ? 'unstage' : 'stage (git add)'}
                          onChange={(e) => act('stage1', () => (e.target.checked ? api.git.stage(svc.id, [c.repoPath]) : api.git.unstage(svc.id, [c.repoPath])))} />
                      </td>
                      <td className="mono small"><a className="link" onClick={() => setSel(c)}>{c.origPath ? `${c.origPath} → ` : ''}{c.path}</a></td>
                      <td className="small">
                        <Badge tone={c.untracked ? 'purple' : c.code === 'D' ? 'red' : c.code === 'A' ? 'green' : 'amber'}>{CODE_LABEL[c.code] ?? c.code}</Badge>
                        {c.staged && c.unstaged ? <span className="muted"> (partially staged)</span> : ''}
                      </td>
                      <td className="cell-actions">
                        <button className="btn btn-sm" onClick={() => setSel(c)}>Diff</button>
                        <button className="btn btn-sm" disabled={!!busy} title={c.untracked ? 'Add to .gitignore (the file stays on disk, never committed)' : 'Add to .gitignore and stop tracking it (git rm --cached — the file stays on disk)'}
                          onClick={() => { if (confirm(`Ignore ${c.path}?\n\nIt is added to the repo's .gitignore${c.untracked ? '' : ' and removed from the index (git rm --cached) — the file stays on disk but will no longer be committed'}.`)) void act('ignore', () => api.git.ignore(svc.id, [{ repoPath: c.repoPath, untracked: c.untracked }]), `${c.path} added to .gitignore`) }}>Ignore</button>
                        <button className="btn btn-sm btn-danger" disabled={!!busy}
                          onClick={() => { if (confirm(c.untracked ? `Delete the untracked file ${c.path}?` : `Discard the changes in ${c.path}? (reverts to the last commit)`)) void act('discard', () => api.git.discard(svc.id, [{ repoPath: c.repoPath, untracked: c.untracked }]), `${c.path} discarded`) }}>Discard</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {sel && (
              <div>
                <div className="row"><span className="mono small grow">{sel.path} {sel.staged && !sel.unstaged ? '(staged)' : ''}</span><button className="btn btn-sm" onClick={() => setSel(null)}>Close</button></div>
                <pre className="resp-body diff">{diff.split('\n').map((l, i) => <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'diff-add' : l.startsWith('-') && !l.startsWith('---') ? 'diff-del' : l.startsWith('@@') ? 'diff-hunk' : ''}>{l || ' '}</div>)}</pre>
              </div>
            )}
          </section>
          <section>
            <h3>Commit</h3>
            <div className="row">
              <input className="input grow" placeholder="commit message" value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && message.trim() && staged.length) void act('commit', () => api.git.commit(svc.id, message, false), () => { setMessage(''); return 'Commit done' }) }} />
              <button className="btn btn-primary" disabled={!!busy || !message.trim() || !staged.length} onClick={() => act('commit', () => api.git.commit(svc.id, message, false), () => { setMessage(''); return 'Commit done' })}>Commit ({staged.length})</button>
              <button className="btn" disabled={!!busy || !message.trim() || !info.changes.length} title="git add -A (in this folder) + commit" onClick={() => act('commit', () => api.git.commit(svc.id, message, true), () => { setMessage(''); return 'Commit done' })}>Stage all + commit</button>
            </div>
          </section>
          {stashes.length > 0 && (
            <section>
              <h3>Stashes <span className="count">{stashes.length}</span></h3>
              <p className="muted small"><b>Apply</b> brings the changes back and keeps the stash; <b>Pop</b> brings them back and removes it. Both can conflict with the current tree — resolve like a merge.</p>
              <table className="grid">
                <thead><tr><th>Ref</th><th>Message</th><th>When</th><th></th></tr></thead>
                <tbody>
                  {stashes.map((s) => (
                    <tr key={s.ref}>
                      <td className="mono small">{s.ref}</td>
                      <td className="small">{s.message}</td>
                      <td className="small muted">{s.when ?? ''}</td>
                      <td className="cell-actions">
                        <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => act('stash-apply', () => api.git.stashApply(svc.id, s.ref, false), `${s.ref} applied (kept in the stash)`)}>Apply</button>
                        <button className="btn btn-sm" disabled={!!busy} onClick={() => act('stash-pop', () => api.git.stashApply(svc.id, s.ref, true), `${s.ref} applied and removed`)}>Pop</button>
                        <button className="btn btn-sm btn-danger" disabled={!!busy} onClick={() => { if (confirm(`Drop ${s.ref} ("${s.message}")? The stashed changes are lost.`)) void act('stash-drop', () => api.git.stashDrop(svc.id, s.ref), `${s.ref} dropped`) }}>Drop</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}

      {tab === 'branches' && (
        <>
          <section>
            <h3>New branch</h3>
            <div className="row">
              <input className="input mono grow" placeholder="feature/name" value={newBranch} onChange={(e) => setNewBranch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && newBranch.trim() && void createBranch()} />
              <label className="inline">from
                <select className="input mono input-inline" value={fromBranch} onChange={(e) => setFromBranch(e.target.value)} title="Branch the new one is copied from (origin/… = the remote's latest fetched state)">
                  {remote.length > 0 && <optgroup label="remote">{remote.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}</optgroup>}
                  {local.length > 0 && <optgroup label="local">{local.map((b) => <option key={b.name} value={b.name}>{b.name}{b.current ? ' (current)' : ''}</option>)}</optgroup>}
                </select>
              </label>
              <button className="btn btn-primary" disabled={!!busy || !newBranch.trim() || !fromBranch} onClick={() => void createBranch()}>Create and switch</button>
            </div>
            {/^(origin|upstream)\//.test(fromBranch) && <p className="muted small">Copied from the remote branch as last fetched — do a <b>Fetch</b> first if it may be stale. The new branch does not track {fromBranch}.</p>}
            {info.changes.length > 0 && <p className="muted small">Uncommitted changes come with you to the new branch.</p>}
          </section>
          <section>
            <div className="row">
              <h3 className="grow">Branches</h3>
              <label className="check"><input type="checkbox" checked={showRemote} onChange={(e) => setShowRemote(e.target.checked)} /> show remote ({remote.length})</label>
            </div>
            <table className="grid">
              <thead><tr><th>Branch</th><th>Upstream</th><th>Last commit</th><th></th></tr></thead>
              <tbody>
                {[...local, ...(showRemote ? remote : [])].map((b) => (
                  <tr key={b.name}>
                    <td className="mono">{b.current ? <b>⎇ {b.name}</b> : b.name}{b.remote && <Badge>remote</Badge>}</td>
                    <td className="mono small muted">{b.upstream ?? ''}</td>
                    <td className="small muted">{b.when}{b.subject ? ` — ${b.subject}` : ''}</td>
                    <td className="cell-actions">
                      {!b.current && (
                        <button className="btn btn-sm" disabled={!!busy} onClick={() => act('checkout', () => api.git.checkout(svc.id, b.name), `Now on ${b.name.replace(/^(origin|upstream)\//, '')}`)}>Switch to</button>
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
          <h3>Latest commits {info.prefix ? '(touching this folder)' : ''}</h3>
          <table className="grid">
            <tbody>
              {log.map((c) => (
                <tr key={c.hash}>
                  <td className="mono small">{c.hash}</td>
                  <td>{c.subject}{c.refs && <span className="muted small"> ({c.refs})</span>}</td>
                  <td className="small muted">{c.author}, {c.when}</td>
                </tr>
              ))}
              {!log.length && <tr><td className="muted">No commits.</td></tr>}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
