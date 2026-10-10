import { useEffect, useMemo, useRef, useState } from 'react'
import type { ContainerRow, InspectSummary, StatsRow } from '../../../shared/types'
import { api } from '../api'
import { useStream } from '../hooks'
import { ConsoleOut, Dot, Pill, errMsg, execText, type Notify } from './common'

type Tab = 'logs' | 'shell' | 'inspect' | 'stats' | 'env'

export function ContainerDetail({ container, initialTab = 'logs', logsTail, notify, onBack, onChanged }: {
  container: ContainerRow; initialTab?: Tab; logsTail: number; notify: Notify; onBack: () => void; onChanged: () => Promise<void>
}) {
  const [c, setC] = useState(container)
  const [tab, setTab] = useState<Tab>(initialTab)
  const [busy, setBusy] = useState<string | null>(null)
  const [info, setInfo] = useState<InspectSummary | null>(null)
  useEffect(() => { setC(container) }, [container])
  useEffect(() => { void api.containers.inspect(c.name).then(setInfo).catch(() => setInfo(null)) }, [c.name, c.state])
  // estado atualizado (o pai faz o poll da lista)
  const up = c.state === 'running'

  const act = async (action: string): Promise<void> => {
    setBusy(action)
    try {
      await api.containers.action(c.name, action, action === 'remove')
      notify(`${c.name}: ${action} ✓`, 'success')
      await onChanged()
      const list = await api.containers.list(true)
      const n = list.find((x) => x.id === c.id)
      if (n) setC(n); else onBack()
    } catch (e) { notify(errMsg(e), 'error') } finally { setBusy(null) }
  }

  return (
    <div className="page">
      <div className="row small muted"><button className="link" onClick={onBack} style={{ color: 'var(--muted)' }}>Containers</button> › <span style={{ color: 'var(--text)' }}>{c.name}</span></div>
      <div className="row" style={{ gap: 16 }}>
        <h1 className="mono">{c.name}</h1>
        <Pill tone={up ? 'green' : c.state === 'paused' ? 'amber' : 'muted'}><Dot state={c.state} />{c.state} · {c.status.replace(/\s*\((healthy|unhealthy|starting)\)/, '')}{c.ports.length ? ` · ${c.ports.join(', ')}` : ''}</Pill>
        {c.health && <Pill tone={c.health === 'healthy' ? 'green' : c.health === 'unhealthy' ? 'red' : 'amber'}>{c.health}</Pill>}
        <span className="grow" />
        {up ? (
          <>
            <button className="btn" disabled={!!busy} onClick={() => void act('restart')}>⟳ Restart</button>
            <button className="btn" disabled={!!busy} onClick={() => void act('pause')}>⏸ Pause</button>
            <button className="btn btn-danger" disabled={!!busy} onClick={() => void act('stop')}>■ Stop</button>
          </>
        ) : (
          <>
            <button className="btn btn-primary" disabled={!!busy} onClick={() => void act(c.state === 'paused' ? 'unpause' : 'start')}>▶ {c.state === 'paused' ? 'Unpause' : 'Start'}</button>
            <button className="btn btn-danger" disabled={!!busy} onClick={() => { if (confirm(`Remover ${c.name}?`)) void act('remove') }}>Remove</button>
          </>
        )}
      </div>
      <div className="muted small mono">{c.image} · {c.id.slice(0, 12)}{info?.networks.length ? ` · rede ${info.networks.map((n) => `${n.name} ${n.ip}`).join(', ')}` : ''}{info?.mounts.length ? ` · ${info.mounts.length} mount(s)` : ''}</div>
      <div className="tabs">
        <button className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>Logs</button>
        <button className={tab === 'shell' ? 'active' : ''} onClick={() => setTab('shell')}>Shell</button>
        <button className={tab === 'inspect' ? 'active' : ''} onClick={() => setTab('inspect')}>Inspect</button>
        <button className={tab === 'stats' ? 'active' : ''} onClick={() => setTab('stats')}>Stats</button>
        <button className={tab === 'env' ? 'active' : ''} onClick={() => setTab('env')}>Env{info ? <span className="count">{info.env.length}</span> : null}</button>
      </div>
      {tab === 'logs' && <LogsPanel name={c.name} tail={logsTail} notify={notify} />}
      {tab === 'shell' && <ShellPanel name={c.name} workdir={info?.workdir} up={up} />}
      {tab === 'inspect' && <InspectPanel info={info} />}
      {tab === 'stats' && <StatsPanel id={c.id} up={up} />}
      {tab === 'env' && <EnvPanel info={info} />}
    </div>
  )
}

const LEVEL = (t: string): string => (/\b(ERROR|SEVERE|FATAL|Exception|Traceback)\b/.test(t) ? 'log-err' : /\b(WARN|WARNING)\b/.test(t) ? 'log-warn' : '')

export function LogsPanel({ name, tail, notify }: { name: string; tail: number; notify: Notify }) {
  const [streamId, setStreamId] = useState<string | null>(null)
  const { lines, ended, clear } = useStream(streamId)
  const [filter, setFilter] = useState('')
  const [regex, setRegex] = useState(false)
  const [levels, setLevels] = useState<Set<string>>(new Set())
  const [since, setSince] = useState('')
  const [follow, setFollow] = useState(true)
  const [wrap, setWrap] = useState(false)
  const [paused, setPaused] = useState(false)
  const boxRef = useRef<HTMLPreElement>(null)
  const frozen = useRef<typeof lines>([])

  const start = async (s = since): Promise<void> => {
    try { const r = await api.containers.logs(name, tail, s || undefined); setStreamId(r.stream) } catch (e) { notify(errMsg(e), 'error') }
  }
  useEffect(() => { void start(); return () => { void api.stopStream(`logs:${name}`).catch(() => {}) } // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])
  if (paused) { /* mantém as linhas congeladas */ } else frozen.current = lines
  const shownLines = paused ? frozen.current : lines
  const re = useMemo(() => { if (!filter) return null; try { return regex ? new RegExp(filter, 'i') : null } catch { return null } }, [filter, regex])
  const visible = shownLines.filter((l) => {
    if (levels.size) { const lv = LEVEL(l.text); if (!(lv === 'log-err' && levels.has('error')) && !(lv === 'log-warn' && levels.has('warn')) && !(lv === '' && levels.has('info'))) return false }
    if (!filter) return true
    return re ? re.test(l.text) : l.text.toLowerCase().includes(filter.toLowerCase())
  })
  useEffect(() => { if (follow && !paused && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight }, [visible.length, follow, paused])
  const toggleLevel = (k: string): void => setLevels((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const download = (): void => {
    const blob = new Blob([shownLines.map((l) => l.text).join('\n')], { type: 'text/plain' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${name}.log`; a.click(); URL.revokeObjectURL(a.href)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="row">
        <label className="search" style={{ width: 280, height: 32 }}><input placeholder={regex ? 'regex…' : 'filtrar…'} value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
        <label className="inline"><input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> regex</label>
        {[['error', 'ERROR', 'var(--red)'], ['warn', 'WARN', 'var(--amber)'], ['info', 'INFO', 'var(--muted)']].map(([k, label, color]) => (
          <button key={k} className="btn btn-sm" style={{ color, borderColor: levels.has(k) ? color : undefined, fontWeight: 700, fontSize: 11 }} onClick={() => toggleLevel(k)}>{label}</button>
        ))}
        <select className="input sm" value={since} onChange={(e) => { setSince(e.target.value); void start(e.target.value) }} title="desde (reinicia o stream)">
          <option value="">tail {tail}</option><option value="15m">desde 15 min</option><option value="1h">desde 1 h</option><option value="24h">desde 24 h</option>
        </select>
        <span className="grow" />
        <span className="dim tiny">{visible.length} / {shownLines.length} linhas{ended !== undefined ? ' · stream terminado' : ''}</span>
        <label className="inline"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow</label>
        <label className="inline"><input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> wrap</label>
        <button className="btn btn-sm" onClick={() => setPaused((p) => !p)} title={paused ? 'retomar' : 'pausar a vista (o stream continua)'}>{paused ? '▶' : '⏸'}</button>
        <button className="btn btn-sm" onClick={download}>⤓ Download</button>
        <button className="btn btn-sm" onClick={() => { clear(); void start() }}>⟳ Reiniciar</button>
        <button className="btn btn-sm" onClick={clear}>Clear</button>
      </div>
      <pre ref={boxRef} className={`logs${wrap ? ' wrap' : ''}`}>
        {visible.map((l, i) => <div key={i} className={l.stream === 'system' ? 'log-sys' : LEVEL(l.text)}>{l.text}</div>)}
        {!visible.length && <span className="muted">{shownLines.length ? 'nada corresponde ao filtro' : 'sem output ainda'}</span>}
      </pre>
    </div>
  )
}

function ShellPanel({ name, workdir, up }: { name: string; workdir?: string; up: boolean }) {
  const [cmd, setCmd] = useState('')
  const [cwd, setCwd] = useState('')
  const [user, setUser] = useState('')
  const [shell, setShell] = useState('sh')
  const [out, setOut] = useState('')
  const [hist, setHist] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(`cm.shell.hist`) ?? '[]') as string[] } catch { return [] } })
  const [hi, setHi] = useState(-1)
  const [busy, setBusy] = useState(false)
  const [snips, setSnips] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('cm.shell.snips') ?? 'null') as string[] | null ?? ['env | sort', 'ps -ef 2>/dev/null || ps', 'df -h', '(ss -tlnp || netstat -tlnp) 2>/dev/null', 'cat /etc/os-release'] } catch { return [] } })
  const run = async (text: string): Promise<void> => {
    const t = text.trim(); if (!t) return
    setBusy(true); setCmd(''); setHi(-1)
    setHist((h) => { const n = [t, ...h.filter((x) => x !== t)].slice(0, 100); try { localStorage.setItem('cm.shell.hist', JSON.stringify(n)) } catch { /* */ } return n })
    setOut((o) => `${o ? o + '\n' : ''}$ ${name}${cwd ? ':' + cwd : ''} › ${t}`)
    try { const r = await api.containers.exec(name, t, { cwd: cwd || undefined, user: user || undefined, shell }); setOut((o) => `${o}\n${execText(r)}`) } catch (e) { setOut((o) => `${o}\n✗ ${errMsg(e)}`) } finally { setBusy(false) }
  }
  const saveSnip = (): void => { const t = cmd.trim(); if (!t) return; setSnips((s) => { const n = [...new Set([...s, t])]; try { localStorage.setItem('cm.shell.snips', JSON.stringify(n)) } catch { /* */ } return n }) }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="row">
        <select className="input sm" value={shell} onChange={(e) => setShell(e.target.value)}><option>sh</option><option>bash</option><option>ash</option></select>
        <label className="inline">user <input className="input sm mono" style={{ width: 100 }} value={user} onChange={(e) => setUser(e.target.value)} placeholder="(default)" /></label>
        <label className="inline">dir <input className="input sm mono" style={{ width: 160 }} value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={workdir || '/'} /></label>
        <span className="grow" />
        <button className="btn btn-sm" disabled={!out} onClick={() => setOut('')}>Clear</button>
      </div>
      <div className="search mono" style={{ height: 36 }}>
        <span className="muted">{name} ›</span>
        <input value={cmd} disabled={!up || busy} autoFocus spellCheck={false} placeholder={up ? 'comando (sh -c) — Enter corre, ↑/↓ histórico' : 'o container não está a correr'} onChange={(e) => { setCmd(e.target.value); setHi(-1) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void run(cmd) }
            else if (e.key === 'ArrowUp' && hist.length) { e.preventDefault(); const i = Math.min(hi + 1, hist.length - 1); setHi(i); setCmd(hist[i]) }
            else if (e.key === 'ArrowDown') { e.preventDefault(); const i = hi - 1; setHi(i); setCmd(i < 0 ? '' : hist[i]) }
          }} />
        <button className="btn btn-sm btn-primary" disabled={!up || busy || !cmd.trim()} onClick={() => void run(cmd)}>{busy ? '…' : '▶'}</button>
      </div>
      <ConsoleOut text={out} placeholder="(sem output ainda — escreve um comando)" style={{ minHeight: 260, maxHeight: 'calc(100vh - 460px)' }} />
      <div className="chips">
        {snips.map((s) => <button key={s} className="chip mono" disabled={!up || busy} onClick={() => void run(s)} title={s}>{s.length > 36 ? s.slice(0, 34) + '…' : s}</button>)}
        <button className="chip muted" onClick={saveSnip} disabled={!cmd.trim()} title="guarda o comando escrito como atalho">＋ guardar snippet</button>
        {snips.length > 0 && <button className="chip muted" onClick={() => { setSnips([]); try { localStorage.setItem('cm.shell.snips', '[]') } catch { /* */ } }}>limpar snippets</button>}
      </div>
      <p className="muted small">Cada linha corre como <span className="mono">exec {name} {shell} -c "…"</span> — não é uma sessão interativa: <span className="mono">cd</span> não persiste (usa o campo dir); pipes, redirects e <span className="mono">&amp;&amp;</span> funcionam. Imagens JRE/alpine podem não ter <span className="mono">bash</span>/<span className="mono">curl</span>.</p>
    </div>
  )
}

function InspectPanel({ info }: { info: InspectSummary | null }) {
  const [raw, setRaw] = useState(false)
  if (!info) return <div className="muted">A carregar…</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="split">
        <div className="card left">
          <h3>Geral</h3>
          <dl className="props">
            <dt>Id</dt><dd>{info.id.slice(0, 12)}</dd>
            <dt>Imagem</dt><dd>{info.image}</dd>
            <dt>Criado</dt><dd>{info.created}</dd>
            <dt>Estado</dt><dd>{info.state}{info.exitCode !== undefined && info.state !== 'running' ? ` (exit ${info.exitCode})` : ''}</dd>
            <dt>Arrancou</dt><dd>{info.startedAt || '—'}</dd>
            <dt>Terminou</dt><dd>{info.finishedAt && !info.finishedAt.startsWith('0001') ? info.finishedAt : '—'}</dd>
            <dt>Entrypoint</dt><dd>{info.entrypoint.join(' ') || '—'}</dd>
            <dt>Cmd</dt><dd>{info.cmd.join(' ') || '—'}</dd>
            <dt>Workdir / user</dt><dd>{info.workdir || '/'} · {info.user || 'root'}</dd>
            <dt>Restart</dt><dd>{info.restartPolicy}</dd>
          </dl>
        </div>
        <div className="card right">
          <h3>Rede e portas</h3>
          <dl className="props">
            {info.networks.map((n) => <span key={n.name} style={{ display: 'contents' }}><dt>{n.name}</dt><dd>{n.ip || '—'}{n.gateway ? ` (gw ${n.gateway})` : ''}</dd></span>)}
            <dt>Portas</dt><dd>{info.ports.join(', ') || '—'}</dd>
          </dl>
          <h3>Mounts</h3>
          {info.mounts.length ? <dl className="props">{info.mounts.map((m, i) => <span key={i} style={{ display: 'contents' }}><dt>{m.type}{m.ro ? ' (ro)' : ''}</dt><dd>{m.src} → {m.dst}</dd></span>)}</dl> : <div className="muted small">—</div>}
          {info.health && (
            <>
              <h3>Healthcheck</h3>
              <div className="small"><Pill tone={info.health.status === 'healthy' ? 'green' : info.health.status === 'unhealthy' ? 'red' : 'amber'}>{info.health.status}</Pill> falhas seguidas: {info.health.failingStreak}</div>
              {info.health.log.map((l, i) => <div key={i} className="mono tiny muted">{l.start} · exit {l.exitCode} · {l.output.slice(0, 160)}</div>)}
            </>
          )}
          {Object.keys(info.labels).length > 0 && <><h3>Labels</h3><dl className="props">{Object.entries(info.labels).map(([k, v]) => <span key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></span>)}</dl></>}
        </div>
      </div>
      <div className="row"><button className="btn btn-sm" onClick={() => setRaw((v) => !v)}>{raw ? 'Esconder JSON' : 'Ver JSON completo'}</button><button className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(JSON.stringify(info.raw, null, 2))}>Copiar JSON</button></div>
      {raw && <ConsoleOut text={JSON.stringify(info.raw, null, 2)} />}
    </div>
  )
}

function StatsPanel({ id, up }: { id: string; up: boolean }) {
  const [hist, setHist] = useState<StatsRow[]>([])
  useEffect(() => {
    if (!up) return
    let stop = false
    const load = (): void => { void api.containers.stats().then((rows) => { const r = rows.find((x) => x.id.slice(0, 12) === id.slice(0, 12)); if (r && !stop) setHist((h) => [...h.slice(-59), r]) }).catch(() => {}) }
    load(); const t = setInterval(load, 3000)
    return () => { stop = true; clearInterval(t) }
  }, [id, up])
  if (!up) return <div className="muted">O container não está a correr.</div>
  const last = hist[hist.length - 1]
  const cpuSeries = hist.map((r) => parseFloat(r.cpu) || 0)
  const max = Math.max(5, ...cpuSeries)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="split">
        {[['CPU', last?.cpu], ['Memória', last?.mem], ['Mem %', last?.memPerc], ['Rede I/O', last?.net], ['Bloco I/O', last?.block], ['PIDs', last?.pids]].map(([k, v]) => (
          <div key={k} className="card" style={{ flex: '1 1 160px' }}><div className="muted tiny" style={{ textTransform: 'uppercase', letterSpacing: '.04em' }}>{k}</div><div className="mono" style={{ fontSize: 20, fontWeight: 600 }}>{v ?? '…'}</div></div>
        ))}
      </div>
      <div className="card">
        <h3>CPU % (últimos {hist.length * 3} s)</h3>
        <svg role="img" aria-label="CPU ao longo do tempo" viewBox="0 0 600 120" style={{ width: '100%', height: 120 }}>
          <polyline fill="none" stroke="var(--accent)" strokeWidth="2" points={cpuSeries.map((v, i) => `${(i / Math.max(1, 59)) * 600},${120 - (v / max) * 110}`).join(' ')} />
        </svg>
        <div className="muted tiny">amostras a cada 3 s via <span className="mono">stats --no-stream</span></div>
      </div>
    </div>
  )
}

function EnvPanel({ info }: { info: InspectSummary | null }) {
  const [q, setQ] = useState('')
  if (!info) return <div className="muted">A carregar…</div>
  const rows = info.env.map((e) => { const i = e.indexOf('='); return i < 0 ? [e, ''] : [e.slice(0, i), e.slice(i + 1)] }).filter(([k, v]) => !q || `${k}=${v}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="row"><label className="search" style={{ width: 280, height: 32 }}><input placeholder="filtrar…" value={q} onChange={(e) => setQ(e.target.value)} /></label><span className="muted small">{rows.length} variáveis</span><span className="grow" /><button className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(info.env.join('\n'))}>Copiar como .env</button></div>
      <div className="table"><div className="thead" style={{ gridTemplateColumns: '300px minmax(0,1fr)' }}><span>Variável</span><span>Valor</span></div>
        {rows.map(([k, v]) => <div key={k} className="tr" style={{ gridTemplateColumns: '300px minmax(0,1fr)', minHeight: 36 }}><span className="mono small">{k}</span><span className="mono small" style={{ wordBreak: 'break-all' }}>{/pass|secret|token/i.test(k) ? '••••••' : v}</span></div>)}
      </div>
    </div>
  )
}
