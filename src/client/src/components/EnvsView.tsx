import { useCallback, useEffect, useMemo, useState } from 'react'
import type { EnvsInfo, ServiceInfo, ServiceSettings } from '../../../shared/types'
import { api } from '../api'

type Notify = (t: string, k?: 'error' | 'info' | 'success') => void

/**
 * Ambientes: a partir de application-local.yml gera application-<perfil>.yml escolhendo,
 * chave a chave, de que ambiente vem o valor. Toggle para arrancar o serviço com esse perfil.
 */
export function EnvsView({
  svc, settings, notify, fail, onChanged, onSetProfile
}: {
  svc: ServiceInfo
  settings: ServiceSettings
  notify: Notify
  fail: (e: unknown) => void
  onChanged: () => Promise<void>
  onSetProfile: (profile?: string) => Promise<void>
}) {
  const [info, setInfo] = useState<EnvsInfo | null>(null)
  const [target, setTarget] = useState('local-mix')
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [generated, setGenerated] = useState<{ file: string; warnings: string[] } | null>(null)

  const load = useCallback(async () => {
    try {
      const i = await api.envs(svc.id)
      setInfo(i)
      if (i.mix) {
        setTarget(i.mix.target)
        setChoices(i.mix.choices)
      }
    } catch (e) {
      fail(e)
    }
  }, [svc.id, fail])

  useEffect(() => {
    void load()
  }, [load])

  const sources = useMemo(() => (info ? info.profiles.filter((p) => !info.generated.includes(p)) : []), [info])
  const base = sources.includes('local') ? 'local' : sources[0] ?? ''
  const rows = useMemo(() => (info ? info.keys.filter((k) => new Set(sources.map((p) => k.values[p])).size > 1) : []), [info, sources])
  const targetName = target.trim()
  const usedAtStart = !!targetName && settings.profile === targetName
  const ext = info?.files[base]?.slice(info.files[base].lastIndexOf('.')) ?? '.yml'

  const choose = (key: string, env: string): void => {
    setChoices((c) => {
      const next = { ...c }
      if (env === base) delete next[key]
      else next[key] = env
      return next
    })
  }

  const generate = async (force = false): Promise<void> => {
    if (!targetName || targetName === base) return
    setBusy(true)
    try {
      const r = await api.composeEnv(svc.id, { base, target: targetName, choices, force, setProfile: usedAtStart })
      setGenerated({ file: r.file, warnings: r.warnings })
      notify(`Gerado application-${targetName}${ext}`, 'success')
      await onChanged()
      await load()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!force && msg.includes('não foi gerado') && confirm(`${msg}\n\nSubstituir?`)) return generate(true)
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const toggleStart = async (on: boolean): Promise<void> => {
    try {
      await onSetProfile(on ? targetName : undefined)
    } catch (e) {
      fail(e)
    }
  }

  if (!info) return <div className="empty">A ler ficheiros de ambiente…</div>
  if (!sources.length) {
    return (
      <div className="empty">
        <p>Sem ficheiros <span className="mono">application-&lt;ambiente&gt;.yml</span> em</p>
        <p className="mono small muted">{info.resourcesDir}</p>
      </div>
    )
  }

  return (
    <div className="config envs">
      <section>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label className="inline">Ficheiro local
            <span className="mono muted">application-</span>
            <input className="input mono" style={{ width: 130 }} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="local-mix" />
            <span className="mono muted">{ext}</span>
          </label>
          <button className="btn btn-primary" disabled={busy || !targetName || targetName === base} onClick={() => generate()}>
            {busy ? 'A gerar…' : 'Gerar'}
          </button>
          <label className={`switch${usedAtStart ? ' on' : ''}`} title={`Arrancar o serviço com o perfil ${targetName || '…'} (application.yml + application-${targetName || '…'}${ext})`}>
            <input type="checkbox" checked={usedAtStart} disabled={!targetName} onChange={(e) => toggleStart(e.target.checked)} />
            <span className="switch-track"><span className="switch-knob" /></span>
            <span className="switch-label">usar no arranque</span>
          </label>
          <span className="grow" />
          {generated && <span className="muted small mono ellipsis" title={generated.file}>gerado: {generated.file.split(/[\\/]/).pop()}</span>}
          {!generated && info.generated.includes(targetName) && <span className="muted small">application-{targetName}{ext} existe — Gerar substitui-o</span>}
        </div>
        {generated?.warnings.map((w) => <div key={w} className="small" style={{ color: 'var(--amber)' }}>⚠ {w}</div>)}
      </section>

      <section>
        <table className="grid envs-table">
          <thead>
            <tr>
              <th>Variável</th>
              {sources.map((p) => <th key={p}>{p}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const chosen = choices[r.key] ?? base
              return (
                <tr key={r.key}>
                  <td className="mono small">{r.key}</td>
                  {sources.map((p) => {
                    const has = r.values[p] !== undefined
                    return (
                      <td key={p} className={`mono small val${p === chosen ? ' chosen' : ''}${has ? '' : ' missing'}`} title={has ? `${r.values[p]} — clicar para usar o valor de ${p}` : 'não existe neste ambiente'}
                        onClick={() => has && choose(r.key, p)}>
                        {p === chosen ? '✓ ' : ''}{r.values[p] ?? '—'}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {!rows.length && <tr><td colSpan={sources.length + 1} className="muted">Nenhuma variável difere entre ambientes.</td></tr>}
          </tbody>
        </table>
        <p className="muted small">Clica no valor que queres usar em cada variável. As restantes ficam como em <span className="mono">{base}</span>.</p>
      </section>
    </div>
  )
}
