import { useMemo, useState } from 'react'
import { EMPTY_SPEC, runCommandLine } from '../../../shared/run'
import type { AppSettings, ContainerRow, ImageRow, NetworkRow, RunSpec } from '../../../shared/types'
import { api } from '../api'
import { usePoll } from '../hooks'
import { errMsg, type Notify } from './common'

export function CreateView({ settings, initialImage, notify, onBack, onCreated, onSaveSettings }: {
  settings: AppSettings; initialImage?: string; notify: Notify; onBack: () => void; onCreated: () => void; onSaveSettings: (p: Partial<AppSettings>) => Promise<void>
}) {
  const [spec, setSpec] = useState<RunSpec>({ ...EMPTY_SPEC, image: initialImage ?? '' })
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>('')
  const images = usePoll(() => api.images.list(true), 0).data ?? []
  const networks = usePoll(() => api.networks.list(true), 0).data ?? []
  const containers = usePoll(() => api.containers.list(true), 0).data ?? []
  const set = <K extends keyof RunSpec>(k: K, v: RunSpec[K]): void => setSpec((s) => ({ ...s, [k]: v }))
  const cmdLine = useMemo(() => runCommandLine(settings.containerCommand || 'podman', spec, true), [spec, settings.containerCommand])
  const localImage = images.some((i: ImageRow) => i.repoTags.includes(spec.image.trim()))
  // portas do host já publicadas por outros containers (aviso de conflito)
  const usedPorts = useMemo(() => { const s = new Map<string, string>(); for (const c of containers as ContainerRow[]) for (const p of c.ports) { const m = /(\d+)→/.exec(p); if (m) s.set(m[1], c.name) } return s }, [containers])
  const nameTaken = (containers as ContainerRow[]).some((c) => c.name === spec.name?.trim())

  const create = async (start: boolean): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.containers.run(start ? spec : { ...spec, extraArgs: `${spec.extraArgs ?? ''}`.trim() })
      setResult(`${r.command}\n${r.output}`)
      notify(`Container criado${start ? ' e a arrancar' : ''}`, 'success')
      onCreated()
    } catch (e) { setResult(`✗ ${errMsg(e)}`); notify(errMsg(e), 'error') } finally { setBusy(false) }
  }
  const saveTemplate = async (): Promise<void> => {
    const name = prompt('Nome do modelo', spec.name || spec.image.split('/').pop() || 'modelo'); if (!name) return
    await onSaveSettings({ templates: [...settings.templates.filter((t) => t.name !== name), { name, spec }] })
    notify(`modelo "${name}" guardado`, 'success')
  }
  const listRow = <T,>(arr: T[], i: number, patch: Partial<T>): T[] => arr.map((x, j) => (j === i ? { ...x, ...patch } : x))
  const inputCls = 'input sm mono'

  return (
    <div className="page">
      <div className="row small muted"><button className="link" onClick={onBack} style={{ color: 'var(--muted)' }}>Containers</button> › <span style={{ color: 'var(--text)' }}>Novo container</span></div>
      <h1>Novo container</h1>
      <div className="muted small">Preenche o formulário — o comando <span className="mono">{settings.containerCommand || 'podman'} run</span> gerado aparece à direita e pode ser copiado.</div>
      <div className="split">
        <div className="left">
          <div className="card">
            <h3>Base</h3>
            <div className="form-grid">
              <label className="col">Imagem{spec.image.trim() && <span className={localImage ? 'text-ok' : 'text-warn'} style={{ fontSize: 11 }}>{localImage ? ' · local' : ' · não existe localmente: será feito pull'}</span>}
                <input className="input mono" list="cm-images" value={spec.image} onChange={(e) => set('image', e.target.value)} placeholder="docker.io/library/postgres:17-alpine" />
                <datalist id="cm-images">{images.flatMap((i: ImageRow) => i.repoTags).map((t) => <option key={t} value={t} />)}</datalist>
              </label>
              <label className="col">Nome{nameTaken && <span className="text-warn" style={{ fontSize: 11 }}> · já existe um container com este nome</span>}<input className="input mono" value={spec.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder="(gerado pelo motor)" /></label>
            </div>
            <div className="row">
              <label className="inline"><input type="checkbox" checked={spec.detach} onChange={(e) => set('detach', e.target.checked)} /> detached (-d)</label>
              <label className="inline"><input type="checkbox" checked={spec.rm} onChange={(e) => set('rm', e.target.checked)} /> remover ao parar (--rm)</label>
              <label className="inline">restart <select className="input sm" value={spec.restart ?? 'no'} onChange={(e) => set('restart', e.target.value)}><option>no</option><option>on-failure</option><option>unless-stopped</option><option>always</option></select></label>
              <label className="inline">rede <select className="input sm" value={spec.network ?? ''} onChange={(e) => set('network', e.target.value)}><option value="">(default)</option>{networks.map((n: NetworkRow) => <option key={n.name} value={n.name}>{n.name}</option>)}<option value="host">host</option></select></label>
            </div>
          </div>

          <div className="card">
            <div className="row"><h3 style={{ margin: 0 }}>Portas</h3><span className="dim tiny">host → container</span><span className="grow" /><button className="btn btn-sm" onClick={() => set('ports', [...spec.ports, { host: '', container: '', proto: 'tcp' }])}>＋ porta</button></div>
            {spec.ports.map((p, i) => {
              const conflict = p.host.trim() && usedPorts.get(p.host.trim())
              return (
                <div key={i} className="kv" style={{ gridTemplateColumns: '120px 20px 120px 80px minmax(0,1fr) 30px' }}>
                  <input className={inputCls} value={p.host} onChange={(e) => set('ports', listRow(spec.ports, i, { host: e.target.value }))} placeholder="8080" />
                  <span className="dim" style={{ textAlign: 'center' }}>→</span>
                  <input className={inputCls} value={p.container} onChange={(e) => set('ports', listRow(spec.ports, i, { container: e.target.value }))} placeholder="8080" />
                  <select className="input sm" value={p.proto} onChange={(e) => set('ports', listRow(spec.ports, i, { proto: e.target.value as 'tcp' | 'udp' }))}><option>tcp</option><option>udp</option></select>
                  <span className="text-warn tiny">{conflict ? `⚠ ${p.host} já publicada por ${conflict}` : ''}</span>
                  <button className="btn btn-sm btn-ghost" aria-label="remover" onClick={() => set('ports', spec.ports.filter((_, j) => j !== i))}>✕</button>
                </div>
              )
            })}
          </div>

          <div className="card">
            <div className="row"><h3 style={{ margin: 0 }}>Variáveis de ambiente</h3><span className="grow" /><button className="btn btn-sm" onClick={() => { const t = prompt('Cola o conteúdo .env (KEY=value por linha)'); if (!t) return; const rows = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return { key: i < 0 ? l : l.slice(0, i), value: i < 0 ? '' : l.slice(i + 1) } }); set('env', [...spec.env.filter((e) => e.key), ...rows]) }}>⤒ .env</button><button className="btn btn-sm" onClick={() => set('env', [...spec.env, { key: '', value: '' }])}>＋ variável</button></div>
            {spec.env.map((e, i) => (
              <div key={i} className="kv" style={{ gridTemplateColumns: '240px minmax(0,1fr) 30px' }}>
                <input className={inputCls} value={e.key} onChange={(ev) => set('env', listRow(spec.env, i, { key: ev.target.value }))} placeholder="KEY" />
                <input className={inputCls} type={/pass|secret|token/i.test(e.key) ? 'password' : 'text'} value={e.value} onChange={(ev) => set('env', listRow(spec.env, i, { value: ev.target.value }))} placeholder="value" />
                <button className="btn btn-sm btn-ghost" aria-label="remover" onClick={() => set('env', spec.env.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="row"><h3 style={{ margin: 0 }}>Volumes</h3><span className="dim tiny">pasta do host ou volume → caminho no container</span><span className="grow" /><button className="btn btn-sm" onClick={() => set('volumes', [...spec.volumes, { src: '', dst: '', ro: false }])}>＋ volume</button></div>
            {spec.volumes.map((v, i) => (
              <div key={i} className="kv" style={{ gridTemplateColumns: 'minmax(0,1fr) 20px 220px 60px 30px' }}>
                <input className={inputCls} value={v.src} onChange={(e) => set('volumes', listRow(spec.volumes, i, { src: e.target.value }))} placeholder="C:\dados\postgres ou nome-do-volume" />
                <span className="dim" style={{ textAlign: 'center' }}>→</span>
                <input className={inputCls} value={v.dst} onChange={(e) => set('volumes', listRow(spec.volumes, i, { dst: e.target.value }))} placeholder="/var/lib/postgresql/data" />
                <label className="inline"><input type="checkbox" checked={v.ro} onChange={(e) => set('volumes', listRow(spec.volumes, i, { ro: e.target.checked }))} /> ro</label>
                <button className="btn btn-sm btn-ghost" aria-label="remover" onClick={() => set('volumes', spec.volumes.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="form-grid">
              <label className="col">Comando (opcional)<input className="input mono" value={spec.command ?? ''} onChange={(e) => set('command', e.target.value)} placeholder='ex.: sh -c "exec java -jar /app/*.jar"' /></label>
              <label className="col">Labels (k=v, separados por vírgula)<input className="input mono" value={spec.labels.map((l) => `${l.key}=${l.value}`).join(', ')} onChange={(e) => set('labels', e.target.value.split(',').map((s) => s.trim()).filter(Boolean).map((s) => { const i = s.indexOf('='); return { key: i < 0 ? s : s.slice(0, i), value: i < 0 ? '' : s.slice(i + 1) } }))} placeholder="project=msm, owner=helder" /></label>
              <label className="col">Healthcheck (--health-cmd)<input className="input mono" value={spec.healthCmd ?? ''} onChange={(e) => set('healthCmd', e.target.value)} placeholder="pg_isready -U postgres" /></label>
              <label className="col">Limites<div className="row"><input className="input mono" style={{ width: 110 }} value={spec.memory ?? ''} onChange={(e) => set('memory', e.target.value)} placeholder="--memory 1g" /><input className="input mono" style={{ width: 90 }} value={spec.cpus ?? ''} onChange={(e) => set('cpus', e.target.value)} placeholder="--cpus 2" /></div></label>
              <label className="col" style={{ gridColumn: '1 / -1' }}>Argumentos extra do run<input className="input mono" value={spec.extraArgs ?? ''} onChange={(e) => set('extraArgs', e.target.value)} placeholder="--add-host foo:1.2.3.4 --user 1000" /></label>
            </div>
          </div>
        </div>

        <div className="right">
          <div className="card">
            <div className="row"><h3 style={{ margin: 0 }}>Comando gerado</h3><span className="grow" /><button className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(runCommandLine(settings.containerCommand || 'podman', spec, false)).then(() => notify('comando copiado', 'info'))}>Copiar</button></div>
            <pre className="console-out" style={{ color: 'var(--green)', maxHeight: 320 }}>{cmdLine.replace(/ (-[a-z-]+ )/g, ' \\\n  $1')}</pre>
          </div>
          <div className="card">
            <h3>Modelos</h3>
            <div className="chips">
              {settings.templates.map((t) => <button key={t.name} className="chip" onClick={() => setSpec({ ...EMPTY_SPEC, ...t.spec })}>{t.name}</button>)}
              <button className="chip muted" onClick={() => void saveTemplate()}>＋ guardar este como modelo</button>
            </div>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onBack}>Cancelar</button>
            <button className="btn btn-primary" disabled={busy || !spec.image.trim()} onClick={() => void create(true)}>{busy ? 'A criar…' : '▶ Criar e arrancar'}</button>
          </div>
          {result && <pre className="console-out" style={{ maxHeight: 200 }}>{result}</pre>}
        </div>
      </div>
    </div>
  )
}
