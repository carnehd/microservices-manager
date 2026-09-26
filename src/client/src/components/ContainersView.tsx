import { useCallback, useEffect, useState } from 'react'
import type { ContainerInfo, EngineInfo, ImageInfo, ProcState } from '../../../shared/types'
import { api } from '../api'
import type { LogsApi } from '../hooks'
import { LogView } from './LogView'
import { Badge, StatusDot, isActive } from './common'

type Tab = 'containers' | 'images' | 'logs'
type Notify = (t: string, k?: 'error' | 'info' | 'success') => void
const REFRESH_MS = 5000

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
            {engine === null && 'a verificar o motor…'}
            {engine && !engine.available && <span className="text-error">{engine.error}</span>}
            {engine?.available && (
              <>
                cliente {engine.clientVersion ?? '?'}{engine.serverVersion ? ` · servidor ${engine.serverVersion}` : ''}
                {machine && <> · máquina <b>{machine.name}</b> {machine.running ? 'a correr' : machine.starting ? 'a arrancar' : 'parada'}{machine.lastUp && !machine.running ? ` (última vez: ${machine.lastUp})` : ''}</>}
                {engine.error && <span className="text-error"> · {engine.error}</span>}
              </>
            )}
            {containers && <> · {running} a correr de {containers.length}</>}
          </div>
        </div>
      </div>

      <div className="actions">
        {machine && (machineDown ? (
          <button className="btn btn-primary" disabled={!!busy} onClick={() => act('machine', () => api.containers.machine(machine.name, 'start'), `Máquina ${machine.name} arrancada`)}>
            {busy === 'machine' ? 'A arrancar a máquina…' : `▶ Arrancar máquina ${machine.name}`}
          </button>
        ) : (
          <button className="btn" disabled={!!busy} onClick={() => act('machine', () => api.containers.machine(machine.name, 'stop'), `Máquina ${machine.name} parada`)}>■ Parar máquina</button>
        ))}
        <button className="btn" disabled={!!busy} onClick={() => { void refresh(); void refreshEngine() }}>⟳ Atualizar</button>
        <label className="check"><input type="checkbox" checked={onlyRunning} onChange={(e) => setOnlyRunning(e.target.checked)} /> só a correr</label>
        <span className="grow" />
        <span className="muted small">atualiza a cada {REFRESH_MS / 1000} s</span>
      </div>

      <div className="tabs">
        <button className={tab === 'containers' ? 'active' : ''} onClick={() => setTab('containers')}>Containers {containers ? <span className="count">{running}</span> : null}</button>
        <button className={tab === 'images' ? 'active' : ''} onClick={() => setTab('images')}>Imagens {images ? <span className="count">{images.length}</span> : null}</button>
        <button className={tab === 'logs' ? 'active' : ''} disabled={!logTarget} onClick={() => setTab('logs')}>Logs{logTarget ? `: ${logTarget}` : ''}</button>
      </div>

      <div className="tab-body">
        {error && tab !== 'logs' && (
          <div className="pad text-error small">
            {error}
            {machineDown && <> — a máquina do Podman está parada; usa "Arrancar máquina".</>}
          </div>
        )}

        {tab === 'containers' && (
          <div className="config">
            <section>
              <table className="grid">
                <thead><tr><th></th><th>Nome</th><th>Imagem</th><th>Estado</th><th>Portas</th><th>Criado</th><th></th></tr></thead>
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
                              <button className="btn btn-sm" disabled={!!busy} onClick={() => act(c.id, () => api.containers.action(c.name, 'restart'), `${c.name} reiniciado`)}>⟳</button>
                              <button className="btn btn-sm btn-danger" disabled={!!busy} onClick={() => act(c.id, () => api.containers.action(c.name, 'stop'), `${c.name} parado`)}>■ Parar</button>
                            </>
                          ) : (
                            <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => act(c.id, () => api.containers.action(c.name, 'start'), `${c.name} iniciado`)}>▶ Iniciar</button>
                          )}
                          <button className="btn btn-sm" disabled={!!busy} onClick={() => openLogs(c)}>Logs</button>
                          <button className="btn btn-sm btn-danger" disabled={!!busy}
                            onClick={() => { if (confirm(`Remover o container ${c.name}?${up ? ' Está a correr — será parado.' : ''}`)) void act(c.id, () => api.containers.action(c.name, 'remove', up), `${c.name} removido`) }}>Remover</button>
                        </td>
                      </tr>
                    )
                  })}
                  {containers && !shown.length && <tr><td colSpan={7} className="muted">{onlyRunning ? 'Nenhum container a correr.' : 'Sem containers.'}</td></tr>}
                  {!containers && !error && <tr><td colSpan={7} className="muted">A carregar…</td></tr>}
                </tbody>
              </table>
            </section>
          </div>
        )}

        {tab === 'images' && (
          <div className="config">
            <section>
              <table className="grid">
                <thead><tr><th>Imagem</th><th>ID</th><th>Tamanho</th><th>Criada</th><th>Containers</th><th></th></tr></thead>
                <tbody>
                  {(images ?? []).map((i) => (
                    <tr key={i.id + i.repoTags.join()}>
                      <td className="mono">{i.repoTags.length ? i.repoTags.map((t) => <div key={t}>{t}</div>) : <span className="muted">&lt;sem tag&gt;</span>}</td>
                      <td className="mono small">{i.id}</td>
                      <td className="small">{i.size}</td>
                      <td className="small muted">{i.created ?? ''}</td>
                      <td className="small">{i.containers ?? ''}</td>
                      <td className="cell-actions">
                        <button className="btn btn-sm btn-danger" disabled={!!busy}
                          onClick={() => { const ref = i.repoTags[0] ?? i.id; if (confirm(`Remover a imagem ${ref}?`)) void act(i.id, () => api.containers.removeImage(ref), `Imagem ${ref} removida`) }}>Remover</button>
                      </td>
                    </tr>
                  ))}
                  {images && !images.length && <tr><td colSpan={6} className="muted">Sem imagens.</td></tr>}
                  {!images && !error && <tr><td colSpan={6} className="muted">A carregar…</td></tr>}
                </tbody>
              </table>
            </section>
          </div>
        )}

        {tab === 'logs' && logProcId && (
          <>
            <div className="toolbar">
              <span className="small">{logTarget} · {isActive(states[logProcId]) ? 'a seguir (-f)' : 'parado'}</span>
              <span className="grow" />
              {isActive(states[logProcId]) ? (
                <button className="btn btn-sm" onClick={() => api.stop(logProcId)}>Parar de seguir</button>
              ) : (
                <button className="btn btn-sm" onClick={() => logTarget && openLogs({ id: logTarget, name: logTarget } as ContainerInfo)}>Voltar a seguir</button>
              )}
            </div>
            <LogView lines={logs.get(logProcId)} version={logs.version} onClear={() => logs.clear(logProcId)} />
          </>
        )}
      </div>
    </main>
  )
}
