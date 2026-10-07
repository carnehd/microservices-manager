import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EnvsInfo, ServiceInfo, ServiceSettings } from '../../../shared/types'
import { api } from '../api'
import { icons } from '../assets/icons'

// Linhas mostradas por omissão (maquete: "Showing 7 of 26 · View all variables").
const PREVIEW_ROWS = 7

type Notify = (t: string, k?: 'error' | 'info' | 'success') => void

/**
 * Ambientes: mostra, por variável, o valor do application.yaml base (default) e o valor
 * num ambiente escolhido (dev/sit/prod/…); permite definir o valor a usar e gerar
 * application-<target>.yml. Toggle para arrancar o serviço com esse perfil.
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
  const [target, setTarget] = useState('custom')
  const [selectedEnv, setSelectedEnv] = useState('')
  const [onlyDiff, setOnlyDiff] = useState(false)
  const [search, setSearch] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [generated, setGenerated] = useState<{ file: string; warnings: string[] } | null>(null)
  // Valores já gravados no perfil gerado (para contar "unsaved changes") e vista parcial/total da tabela.
  const [savedValues, setSavedValues] = useState<Record<string, string>>({})
  const [showAll, setShowAll] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const i = await api.envs(svc.id)
      setInfo(i)
      if (i.mix) {
        setTarget(i.mix.target)
        setValues(i.mix.values ?? {})
        setSavedValues(i.mix.values ?? {})
      }
    } catch (e) {
      fail(e)
    }
  }, [svc.id, fail])

  // ⌘K / Ctrl+K foca a pesquisa de variáveis (maquete).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchRef.current?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Um ficheiro por ambiente: o de k8s tem prioridade; senão o application-<env>. (Gerados pela app ficam de fora.)
  const sources = useMemo(() => {
    if (!info) return []
    const byEnv = new Map<string, string>()
    for (const id of info.profiles) {
      if (info.generated.includes(id)) continue
      const name = info.names?.[id] ?? id
      const cur = byEnv.get(name)
      if (!cur || (info.k8s.includes(id) && !info.k8s.includes(cur))) byEnv.set(name, id)
    }
    return [...byEnv.values()]
  }, [info])
  // Base para gerar o perfil: sempre um application-<env> dos resources (nunca um ficheiro de k8s).
  const resourceIds = useMemo(() => (info ? info.profiles.filter((p) => !info.generated.includes(p) && !info.k8s.includes(p)) : []), [info])
  const base = resourceIds.includes('local') ? 'local' : resourceIds[0] ?? ''
  // Ambiente escolhido no dropdown (fallback ao 1º de sources)
  const env = selectedEnv && sources.includes(selectedEnv) ? selectedEnv : sources[0] ?? ''
  const defaults = info?.defaultValues ?? {}
  // Só para mostrar: ${VAR:default} → default (o ficheiro mantém o placeholder; ${VAR} sem default fica como está).
  const resolvePh = (v?: string): string | undefined => v?.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (m, _k: string, d?: string) => (d !== undefined ? d : m))
  // Todas as variáveis: as dos ficheiros de ambiente + as do application.yaml base (que podem não existir em nenhum perfil).
  const allKeys = useMemo(() => {
    if (!info) return []
    const map = new Map<string, EnvsInfo['keys'][number]>()
    for (const k of info.keys) map.set(k.key, k)
    for (const key of Object.keys(info.defaultValues)) if (!map.has(key)) map.set(key, { key, path: key.split('.'), values: {} })
    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key))
  }, [info])
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    let r = onlyDiff ? allKeys.filter((k) => new Set(sources.map((p) => k.values[p])).size > 1) : allKeys
    if (q) r = r.filter((k) => k.key.toLowerCase().includes(q) || Object.values(k.values).some((v) => (v ?? '').toLowerCase().includes(q)))
    return r
  }, [allKeys, onlyDiff, sources, search])
  const targetName = target.trim()
  const usedAtStart = !!targetName && settings.profile === targetName
  const ext = info?.files[base]?.slice(info.files[base].lastIndexOf('.')) ?? '.yml'

  // valor a usar: override escrito/copiado, senão o default do application.yaml base
  const reset = (key: string): void => setValues((v) => { const n = { ...v }; delete n[key]; return n })

  // Liga o profile no arranque: cria o application-<target> (com os valores escolhidos) e
  // escreve spring.profiles.active no application.yaml base.
  const useAtStart = async (force = false): Promise<void> => {
    if (!targetName || targetName === base) return
    setBusy(true)
    try {
      // valores gerados sempre como ${NOME_ENV:valor} (variável de ambiente sobrepõe-se, senão vale o default)
      const r = await api.composeEnv(svc.id, { base, target: targetName, choices: {}, values, force, setProfile: true })
      setGenerated({ file: r.file, warnings: r.warnings })
      setSavedValues(values)
      notify(`application-${targetName}${ext} created and set as the startup profile`, 'success')
      await onChanged()
      await load()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!force && msg.includes('was not generated by the app') && confirm(`${msg}\n\nReplace?`)) return useAtStart(true)
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const toggleStart = async (on: boolean): Promise<void> => {
    if (on) {
      if (!targetName || targetName === base) {
        notify('Choose a target profile name different from the base', 'error')
        return
      }
      await useAtStart()
      return
    }
    setBusy(true)
    try {
      await onSetProfile(undefined)
      await load()
      notify('Startup profile cleared from the base application file', 'success')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  if (!info) return <div className="empty">Reading environment files…</div>
  if (!sources.length) {
    const defKeys = Object.keys(defaults)
    return (
      <div className="empty">
        <p>Only the base <span className="mono">application</span> exists — there are no <span className="mono">application-&lt;environment&gt;.yml</span> profiles to compare yet.</p>
        <p className="mono small muted">{info.resourcesDir}</p>
        {defKeys.length > 0 && <p className="small muted">{defKeys.length} {defKeys.length === 1 ? 'key' : 'keys'} in the base file.</p>}
      </div>
    )
  }

  // Alterações ainda não gravadas no perfil gerado (diferença entre o editado e o último compose).
  const unsaved = Object.keys({ ...values, ...savedValues }).filter((k) => values[k] !== savedValues[k]).length
  const filtering = !!search.trim() || onlyDiff
  const visible = showAll || filtering ? rows : rows.slice(0, PREVIEW_ROWS)
  const envName = info.names?.[env] ?? env
  const saveChanges = async (): Promise<void> => {
    if (!targetName || targetName === base) { notify('Choose a target profile name different from the base', 'error'); return }
    await useAtStart()
  }

  return (
    <div className="config envs">
      {/* Cabeçalho (maquete "Environment configuration"): título + descrição à esquerda, seletor de ambiente à direita */}
      <div className="envs-head">
        <div>
          <h3 className="envs-title">Environment variables</h3>
          <div className="muted small">Compare defaults and edit the configuration for your environment.</div>
        </div>
        <div className="envs-pick">
          <span className="muted small">Environment</span>
          <label className="env-select" title={info.files[env]}>
            <span className="dot dot-running" aria-hidden="true" />
            <span className="env-name ellipsis">{envName || 'Environment'}</span>
            <select value={env} onChange={(e) => setSelectedEnv(e.target.value)} aria-label="Environment file to compare (k8s file first, else application-<env>)">
              {sources.map((p) => <option key={p} value={p}>{info.names?.[p] ?? p}</option>)}
            </select>
            <img src={icons.chevronDown} alt="" width={15} height={15} />
          </label>
          {info.k8s.includes(env) && <span className="k8s-tag" title={info.files[env]}>k8s</span>}
        </div>
      </div>

      {/* Perfil gerado + "use at startup" (funcionalidade mantida, apresentação compacta) */}
      <div className="envs-profile">
        <label className="inline">Profile
          <span className="mono muted">application-</span>
          <input className="input mono" style={{ width: 130 }} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="custom" />
          <span className="mono muted">{ext}</span>
        </label>
        <label className={`switch${usedAtStart ? ' on' : ''}`} title={`Create application-${targetName || '…'}${ext} and start the service with that profile (application.yml + application-${targetName || '…'}${ext})`}>
          <input type="checkbox" checked={usedAtStart} disabled={busy || !targetName || targetName === base} onChange={(e) => toggleStart(e.target.checked)} />
          <span className="switch-track"><span className="switch-knob" /></span>
          <span className="switch-label">{busy ? 'working…' : 'use at startup'}</span>
        </label>
        {generated && <span className="muted small mono ellipsis" title={generated.file}>created: {generated.file.split(/[\\/]/).pop()}</span>}
        {!generated && info.generated.includes(targetName) && <span className="muted small">application-{targetName}{ext} exists — saving overwrites it</span>}
        {generated?.warnings.map((w) => <span key={w} className="small" style={{ color: 'var(--amber)' }}>⚠ {w}</span>)}
      </div>

      {/* Editor de variáveis (card da maquete) */}
      <div className="var-editor">
        <div className="var-toolbar">
          <label className="var-search">
            <img src={icons.search} alt="" width={15} height={15} />
            <input ref={searchRef} placeholder="Search variable or value…" value={search} onChange={(e) => setSearch(e.target.value)} />
            {search ? <button type="button" className="link small" onClick={() => setSearch('')} title="clear search">✕</button> : <span className="var-kbd">⌘ K</span>}
          </label>
          <span className="muted small grow">{rows.length} {rows.length === 1 ? 'variable' : 'variables'}{rows.length < allKeys.length ? ` of ${allKeys.length}` : ''}</span>
          <label className="check"><input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> Only differences</label>
        </div>

        <div className="var-head">
          <span className="var-col-key">Variable</span>
          <span className="var-col-default">application.yaml (default)</span>
          <span className="var-col-env mono" title={info.files[env]}>{env ? `${envName} — ${info.files[env] ?? ''}` : 'Environment'}<img src={icons.pencil} alt="" width={12} height={12} title="editable column" /></span>
        </div>

        {visible.map((r) => {
          const envVal = r.values[env]
          const edited = r.key in values
          const shown = edited ? values[r.key] : (resolvePh(envVal ?? defaults[r.key]) ?? '')
          return (
            <div className="var-row" key={r.key}>
              <span className="var-col-key mono">{r.key}</span>
              <span className="var-col-default mono muted" title={defaults[r.key] ?? 'does not exist in the base application.yaml'}>{defaults[r.key] ?? '—'}</span>
              <span className="var-col-env">
                <input className={`var-input mono${edited ? ' edited' : ''}`} value={shown} placeholder={resolvePh(envVal ?? defaults[r.key]) ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [r.key]: e.target.value }))}
                  title={`value for "${envName}" (used in the generated file)${envVal !== undefined ? ` · in the file: ${envVal}` : ''}`} />
                {edited && <button type="button" className="link small" title="reset to the detected value" onClick={() => reset(r.key)}>↺</button>}
              </span>
            </div>
          )
        })}
        {!rows.length && <div className="var-row muted small">{onlyDiff ? 'No variable differs between environments.' : 'No variables found.'}</div>}

        <div className="var-footer">
          <img src={icons.check} alt="" width={15} height={15} className={unsaved ? 'dim' : ''} />
          <span className="muted small grow">{unsaved ? `${unsaved} unsaved change${unsaved === 1 ? '' : 's'} — saved with the profile application-${targetName || '…'}${ext}` : 'No unsaved changes'}</span>
          <span className="muted small">Showing {visible.length} of {rows.length}</span>
          {!filtering && rows.length > PREVIEW_ROWS && (
            <button type="button" className="btn" onClick={() => setShowAll((v) => !v)}>
              <img src={icons.arrowDown} alt="" width={15} height={15} style={{ transform: showAll ? 'scaleY(-1)' : undefined }} />{showAll ? 'Show fewer' : 'View all variables'}
            </button>
          )}
          <button type="button" className="btn btn-primary" disabled={busy || !unsaved} onClick={() => void saveChanges()} title={`Write the edited values into application-${targetName || '…'}${ext} (and use it at startup)`}>{busy ? 'Saving…' : 'Save changes'}</button>
        </div>
      </div>
    </div>
  )
}
