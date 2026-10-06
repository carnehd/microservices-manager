import { useCallback, useEffect, useRef, useState } from 'react'
import type { ContainerInfo, EngineInfo, ImageInfo, ProcState } from '../../../shared/types'
import { api } from '../api'
import type { LogsApi } from '../hooks'
import { LogView } from './LogView'
import { Badge, ConsoleOut, StatusDot, isActive } from './common'

type Tab = 'containers' | 'images' | 'logs' | 'console'
type Notify = (t: string, k?: 'error' | 'info' | 'success') => void
const REFRESH_MS = 5000

// Comandos úteis (só leitura/diagnóstico) para a consola — o 1º arg tem de estar na whitelist do servidor.
const USEFUL_CMDS: Array<{ label: string; args: string[] }> = [
  { label: 'machine list — VMs do Podman', args: ['machine', 'list'] },
  { label: 'machine info — detalhes da máquina', args: ['machine', 'info'] },
  { label: 'machine inspect — config da VM (JSON)', args: ['machine', 'inspect'] },
  { label: 'info — motor de containers', args: ['info'] },
  { label: 'version — versões cliente/servidor', args: ['version'] },
  { label: 'ps -a — todos os containers', args: ['ps', '-a'] },
  { label: 'images — imagens locais', args: ['images'] },
  { label: 'stats --no-stream — CPU/memória', args: ['stats', '--no-stream'] },
  { label: 'system df — espaço em disco', args: ['system', 'df'] },
  { label: 'volume ls — volumes', args: ['volume', 'ls'] },
  { label: 'network ls — redes', args: ['network', 'ls'] }
]

export function ContainersView({
  logs, states, notify, fail
}: { logs: LogsApi; states: Record<string, ProcState>; notify: Notify; fail: (e: unknown) => void }) {
  const [engine, setEngine] = useState<EngineInfo | null>(null)
  const [containers, setContainers] = useState<ContainerInfo[] | null>(null)
  const [images, setImages] = useState<ImageInfo[] | null>(null)
  const [tab, setTab] = useState<Tab>('containers')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [onlyRunning, setOnlyRunning] = useState(false)
  const [logTarget, setLogTarget] = useState<string | null>(null)
  const [consoleLog, setConsoleLog] = useState('')
  const [selCmd, setSelCmd] = useState(0)
  const cmdName = engine?.command ?? 'podman'

  const appendConsole = useCallback((text: string) => setConsoleLog((prev) => (prev ? prev + '\n' : '') + text), [])
  const didStartup = useRef(false)
  // Corre um comando (consola): regista o comando e o output (stdout/stderr + código/tempo).
  const runCmd = async (args: string[]): Promise<void> => {
    setBusy('cmd')
    setTab('console')
    appendConsole(`$ ${cmdName} ${args.join(' ')}`)
    try {
      const r = await api.containers.exec(args)
      const out = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join('\n')
      appendConsole(`${out || '(no output)'}\n— exit ${r.code} · ${r.ms} ms`)
    } catch (e) {
      appendConsole(`✗ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }
  // Start/stop da máquina do Podman, com o comando e o resultado visíveis na consola.
  const runMachine = async (action: 'start' | 'stop', name: string): Promise<void> => {
    setBusy('machine')
    setTab('console')
    appendConsole(`$ ${cmdName} machine ${action}${name ? ' ' + name : ''}`)
    try {
      const msg = await api.containers.machine(name, action)
      appendConsole(`${msg || '(done)'}`)
      notify(`Machine ${name} ${action === 'start' ? 'started' : 'stopped'}`, 'success')
      await refresh(true)
      await refreshEngine()
    } catch (e) {
      appendConsole(`✗ ${e instanceof Error ? e.message : String(e)}`)
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const refreshEngine = useCallback(async () => {
    try {
      setEngine(await api.containers.engine())
    } catch (e) {
      fail(e)
    }
  }, [fail])

  const refresh = useCallback(async (quiet = false) => {
    try {
      if (tab === 'images') setImages(await api.containers.images())
      else setContainers(await api.containers.list())
      setError(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      if (!quiet) void refreshEngine()
    }
  }, [tab, refreshEngine])

  useEffect(() => {
    void refreshEngine()
  }, [refreshEngine])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(true), REFRESH_MS)
    return () => clearInterval(t)
  }, [refresh])

  // Ao entrar na página: mostra na consola os comandos (e o output/logs) corridos durante o loading.
  useEffect(() => {
    if (didStartup.current) return
    didStartup.current = true
    setTab('console')
    void (async () => {
      const e = await api.containers.engine().catch(() => null)
      const cn = e?.command ?? 'podman'
      const isDocker = /docker/i.test(cn)
      appendConsole(`--- loading containers page (${new Date().toLocaleTimeString()}) ---`)
      const seq: string[][] = [['version'], ...(isDocker ? [] : [['machine', 'list']]), ['ps', '-a'], ['images']]
      for (const args of seq) {
        appendConsole(`$ ${cn} ${args.join(' ')}`)
        try {
          const r = await api.containers.exec(args)
          const out = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join('\n')
          appendConsole(`${out || '(no output)'}\n— exit ${r.code} · ${r.ms} ms`)
        } catch (err) {
          appendConsole(`✗ ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    })()
  }, [appendConsole])

  const act = async (label: string, fn: () => Promise<unknown>, done?: string): Promise<void> => {
    setBusy(label)
    try {
      await fn()
      if (done) notify(done, 'success')
      await refresh(true)
      await refreshEngine()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const openLogs = async (c: ContainerInfo): Promise<void> => {
    const id = `container:${c.name || c.id}`
    setLogTarget(c.name || c.id)
    setTab('logs')
    try {
      await api.containers.logs(c.name || c.id)
      await logs.load(id)
    } catch (e) {
      fail(e)
    }
  }

  const machine = engine?.machines?.find((m) => m.isDefault) ?? engine?.machines?.[0]
  const machineDown = !!engine?.machines && !!machine && !machine.running
  const shown = (containers ?? []).filter((c) => !onlyRunning || c.state === 'running')
  const running = (containers ?? []).filter((c) => c.state === 'running').length
  const logProcId = logTarget ? `container:${logTarget}` : null

  return (
    <main className="service">
      <div className="svc-header">
        <div className="grow">
          <h2>Containers <Badge tone={engine?.available && !engine.error ? 'green' : 'red'}>{engine?.command ?? '…'}</Badge></h2>
          <div className="muted small">
            {engine === null && 'checking the engine…'}
            {engine && !engine.available && <span className="text-error">{engine.error}</span>}
            {engine?.available && (
              <>
                client {engine.clientVersion ?? '?'}{engine.serverVersion ? ` · server ${engine.serverVersion}` : ''}
                {machine && <> · machine <b>{machine.name}</b> {machine.running ? 'running' : machine.starting ? 'starting' : 'stopped'}{machine.lastUp && !machine.running ? ` (last up: ${machine.lastUp})` : ''}</>}
                {engine.error && <span className="text-error"> · {engine.error}</span>}
              </>
            )}
            {containers && <> · {running} running of {containers.length}</>}
          </div>
        </div>
      </div>

      <div className="actions">
        {machine && (machineDown ? (
          <button className="btn btn-primary" disabled={!!busy} onClick={() => void runMachine('start', machine.name)}>
            {busy === 'machine' ? 'Starting the machine…' : `▶ Start machine ${machine.name}`}
          </button>
        ) : (
          <button className="btn" disabled={!!busy} onClick={() => void runMachine('stop', machine.name)}>{busy === 'machine' ? 'Stopping the machine…' : '■ Stop machine'}</button>
        ))}
        <button className="btn" disabled={!!busy} onClick={() => { void refresh(); void refreshEngine() }}>⟳ Refresh</button>
        <label className="check"><input type="checkbox" checked={onlyRunning} onChange={(e) => setOnlyRunning(e.target.checked)} /> only running</label>
        <span className="grow" />
        <span className="muted small">refreshes every {REFRESH_MS / 1000} s</span>
      </div>

      <div className="tabs">
        <button className={tab === 'containers' ? 'active' : ''} onClick={() => setTab('containers')}>Containers {containers ? <span className="count">{running}</span> : null}</button>
        <button className={tab === 'images' ? 'active' : ''} onClick={() => setTab('images')}>Images {images ? <span className="count">{images.length}</span> : null}</button>
        <button className={tab === 'logs' ? 'active' : ''} disabled={!logTarget} onClick={() => setTab('logs')}>Logs{logTarget ? `: ${logTarget}` : ''}</button>
        <button className={tab === 'console' ? 'active' : ''} onClick={() => setTab('console')}>Console</button>
      </div>

      <div className="tab-body">
        {error && tab !== 'logs' && (
          <div className="pad text-error small">
            {error}
            {machineDown && <> — the Podman machine is stopped; use "Start machine".</>}
          </div>
        )}

        {tab === 'containers' && (
          <div className="config">
            <section>
              <table className="grid">
                <thead><tr><th></th><th>Name</th><th>Image</th><th>State</th><th>Ports</th><th>Created</th><th></th></tr></thead>
                <tbody>
                  {shown.map((c) => {
                    const up = c.state === 'running'
                    return (
                      <tr key={c.id}>
                        <td><StatusDot status={up ? 'running' : c.state === 'paused' ? 'stopping' : 'stopped'} /></td>
                        <td className="mono">{c.name}<div className="muted small">{c.id.slice(0, 12)}</div></td>
                        <td className="mono small">{c.image}</td>
                        <td className="small">{c.status}</td>
                        <td className="mono small">{c.ports.join(', ')}</td>
                        <td className="small muted">{c.created ?? ''}</td>
                        <td className="cell-actions">
                          {up ? (
                            <>
                              <button className="btn btn-sm" disabled={!!busy} onClick={() => act(c.id, () => api.containers.action(c.name, 'restart'), `${c.name} restarted`)}>⟳</button>
                              <button className="btn btn-sm btn-danger" disabled={!!busy} onClick={() => act(c.id, () => api.containers.action(c.name, 'stop'), `${c.name} stopped`)}>■ Stop</button>
                            </>
                          ) : (
                            <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => act(c.id, () => api.containers.action(c.name, 'start'), `${c.name} started`)}>▶ Start</button>
                          )}
                          <button className="btn btn-sm" disabled={!!busy} onClick={() => openLogs(c)}>Logs</button>
                          <button className="btn btn-sm btn-danger" disabled={!!busy}
                            onClick={() => { if (confirm(`Remove the container ${c.name}?${up ? ' It is running — it will be stopped.' : ''}`)) void act(c.id, () => api.containers.action(c.name, 'remove', up), `${c.name} removed`) }}>Remove</button>
                        </td>
                      </tr>
                    )
                  })}
                  {containers && !shown.length && <tr><td colSpan={7} className="muted">{onlyRunning ? 'No containers running.' : 'No containers.'}</td></tr>}
                  {!containers && !error && <tr><td colSpan={7} className="muted">Loading…</td></tr>}
                </tbody>
              </table>
            </section>
          </div>
        )}

        {tab === 'images' && (
          <div className="config">
            <section>
              <table className="grid">
                <thead><tr><th>Image</th><th>ID</th><th>Size</th><th>Created</th><th>Containers</th><th></th></tr></thead>
                <tbody>
                  {(images ?? []).map((i) => (
                    <tr key={i.id + i.repoTags.join()}>
                      <td className="mono">{i.repoTags.length ? i.repoTags.map((t) => <div key={t}>{t}</div>) : <span className="muted">&lt;no tag&gt;</span>}</td>
                      <td className="mono small">{i.id}</td>
                      <td className="small">{i.size}</td>
                      <td className="small muted">{i.created ?? ''}</td>
                      <td className="small">{i.containers ?? ''}</td>
                      <td className="cell-actions">
                        <button className="btn btn-sm btn-danger" disabled={!!busy}
                          onClick={() => { const ref = i.repoTags[0] ?? i.id; if (confirm(`Remove the image ${ref}?`)) void act(i.id, () => api.containers.removeImage(ref), `Image ${ref} removed`) }}>Remove</button>
                      </td>
                    </tr>
                  ))}
                  {images && !images.length && <tr><td colSpan={6} className="muted">No images.</td></tr>}
                  {!images && !error && <tr><td colSpan={6} className="muted">Loading…</td></tr>}
                </tbody>
              </table>
            </section>
          </div>
        )}

        {tab === 'logs' && logProcId && (
          <>
            <div className="toolbar">
              <span className="small">{logTarget} · {isActive(states[logProcId]) ? 'following (-f)' : 'stopped'}</span>
              <span className="grow" />
              {isActive(states[logProcId]) ? (
                <button className="btn btn-sm" onClick={() => api.stop(logProcId)}>Stop following</button>
              ) : (
                <button className="btn btn-sm" onClick={() => logTarget && openLogs({ id: logTarget, name: logTarget } as ContainerInfo)}>Follow again</button>
              )}
            </div>
            <LogView lines={logs.get(logProcId)} version={logs.version} onClear={() => logs.clear(logProcId)} />
          </>
        )}

        {tab === 'console' && (
          <div className="config">
            <div className="toolbar">
              <label className="inline grow">Useful commands
                <select className="input mono grow" value={selCmd} onChange={(e) => setSelCmd(Number(e.target.value))}>
                  {USEFUL_CMDS.map((c, i) => <option key={c.label} value={i}>{cmdName} {c.args.join(' ')} — {c.label.split('—')[1]?.trim() ?? c.label}</option>)}
                </select>
              </label>
              <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => void runCmd(USEFUL_CMDS[selCmd].args)}>{busy === 'cmd' ? 'Running…' : '▶ Run'}</button>
              <button className="btn btn-sm" disabled={!consoleLog} onClick={() => setConsoleLog('')}>Clear</button>
            </div>
            <p className="muted small pad">Read-only diagnostic commands against <span className="mono">{cmdName}</span>. Starting/stopping the Podman machine also shows here.</p>
            <ConsoleOut text={consoleLog} placeholder="(no output yet — run a command or start/stop the machine)" />
          </div>
        )}
      </div>
    </main>
  )
}
