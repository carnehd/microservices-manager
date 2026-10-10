import { useState } from 'react'
import type { EngineInfo, ExecResult } from '../../../shared/types'
import { api } from '../api'
import { ConsoleOut, PageHeader, Pill, errMsg, execText, type Notify } from './common'

const USEFUL: Array<{ label: string; args: string[] }> = [
  { label: 'machine list', args: ['machine', 'list'] }, { label: 'machine info', args: ['machine', 'info'] }, { label: 'machine inspect', args: ['machine', 'inspect'] },
  { label: 'info', args: ['info'] }, { label: 'version', args: ['version'] }, { label: 'system df', args: ['system', 'df'] }, { label: 'ps -a', args: ['ps', '-a'] },
  { label: 'stats --no-stream', args: ['stats', '--no-stream'] }, { label: 'volume ls', args: ['volume', 'ls'] }, { label: 'network ls', args: ['network', 'ls'] }, { label: 'pod ps', args: ['pod', 'ps'] }
]

/** Motor: podman machine (start/stop/restart), versões, espaço, prune, consola de comandos de leitura. */
export function MachineView({ engine, onRefresh, notify }: { engine: EngineInfo | null; onRefresh: () => Promise<void>; notify: Notify }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [out, setOut] = useState('')
  const [sel, setSel] = useState(0)
  const [custom, setCustom] = useState('')
  const run = async (label: string, fn: () => Promise<string | ExecResult>): Promise<void> => {
    setBusy(label)
    setOut((o) => `${o ? o + '\n\n' : ''}$ ${label}`)
    try { const r = await fn(); setOut((o) => `${o}\n${typeof r === 'string' ? r || '(done)' : execText(r)}`); await onRefresh() } catch (e) { setOut((o) => `${o}\n✗ ${errMsg(e)}`); notify(errMsg(e), 'error') } finally { setBusy(null) }
  }
  const runConsole = (args: string[]): Promise<void> => run(`${engine?.command ?? 'podman'} ${args.join(' ')}`, () => api.console(args))
  const sshBroken = /ssh|handshake|connection reset|Cannot connect/i.test(engine?.error ?? '')
  return (
    <div className="page">
      <PageHeader title="Machine" onRefresh={() => void onRefresh()}>
        <Pill tone={engine?.ok ? 'green' : 'red'}>{engine ? (engine.ok ? `${engine.command} ${engine.serverVersion}` : 'motor indisponível') : '…'}</Pill>
      </PageHeader>
      {engine?.error && (
        <div className="card" style={{ borderColor: 'rgba(239,91,91,.5)' }}>
          <div className="text-error">{engine.error}</div>
          {sshBroken && <div className="small muted">Sintoma típico da podman machine com a ligação SSH "pendurada": <b>Restart</b> da machine resolve (pára todos os containers; voltam a arrancar com Start).</div>}
        </div>
      )}
      {engine?.isPodman && (
        <div className="table">
          <div className="thead" style={{ gridTemplateColumns: '220px 120px 80px 100px 100px 180px minmax(0,1fr)' }}><span>Machine</span><span>Estado</span><span>CPUs</span><span>RAM</span><span>Disco</span><span>Último arranque</span><span /></div>
          {engine.machines.map((m) => (
            <div key={m.name} className="tr" style={{ gridTemplateColumns: '220px 120px 80px 100px 100px 180px minmax(0,1fr)' }}>
              <span className="mono small">{m.name}{m.default ? <span className="dim tiny"> · default</span> : null}</span>
              <span><Pill tone={m.running ? 'green' : 'muted'}>{m.running ? 'running' : 'stopped'}</Pill></span>
              <span className="small">{m.cpus ?? '—'}</span><span className="small">{m.memory || '—'}</span><span className="small">{m.disk || '—'}</span><span className="small muted">{m.lastUp || '—'}</span>
              <div className="actions">
                {m.running ? <button className="btn btn-sm btn-danger" disabled={!!busy} onClick={() => { if (confirm('Parar a machine pára todos os containers. Continuar?')) void run(`machine stop ${m.name}`, () => api.machine(m.name, 'stop')) }}>■ Stop</button>
                  : <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => void run(`machine start ${m.name}`, () => api.machine(m.name, 'start'))}>▶ Start</button>}
                <button className="btn btn-sm" disabled={!!busy} onClick={() => { if (confirm('Restart pára todos os containers. Continuar?')) void run(`machine restart ${m.name}`, () => api.machine(m.name, 'restart')) }}>⟳ Restart</button>
              </div>
            </div>
          ))}
          {!engine.machines.length && <div className="tr muted" style={{ gridTemplateColumns: '1fr' }}>Sem podman machine (Linux nativo) — nada a gerir aqui.</div>}
        </div>
      )}
      <div className="card">
        <h3>Espaço e limpeza</h3>
        <div className="row">
          <button className="btn btn-sm" disabled={!!busy} onClick={() => void run('system df', () => api.systemDf())}>system df</button>
          <button className="btn btn-sm btn-warn" disabled={!!busy} onClick={() => { if (confirm('system prune: remove containers parados, redes não usadas e imagens dangling. Continuar?')) void run('system prune', () => api.systemPrune(false)) }}>system prune</button>
          <button className="btn btn-sm btn-danger" disabled={!!busy} onClick={() => { if (confirm('system prune --volumes: inclui VOLUMES não usados (dados perdem-se). Continuar?')) void run('system prune --volumes', () => api.systemPrune(true)) }}>prune + volumes</button>
        </div>
      </div>
      <div className="card">
        <h3>Consola (comandos de leitura)</h3>
        <div className="row">
          <select className="input sm mono" value={sel} onChange={(e) => setSel(Number(e.target.value))}>{USEFUL.map((u, i) => <option key={u.label} value={i}>{engine?.command ?? 'podman'} {u.args.join(' ')}</option>)}</select>
          <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => void runConsole(USEFUL[sel].args)}>▶ Run</button>
          <span className="dim">ou</span>
          <input className="input sm mono grow" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="argumentos (ex.: inspect msm-redis · port msm-keycloak · top msm-redis)" onKeyDown={(e) => { if (e.key === 'Enter' && custom.trim()) void runConsole(custom.trim().split(/\s+/)) }} />
          <button className="btn btn-sm" disabled={!!busy || !custom.trim()} onClick={() => void runConsole(custom.trim().split(/\s+/))}>Run</button>
          <button className="btn btn-sm" disabled={!out} onClick={() => setOut('')}>Clear</button>
        </div>
        <ConsoleOut text={out} placeholder="(sem output ainda)" />
      </div>
    </div>
  )
}
