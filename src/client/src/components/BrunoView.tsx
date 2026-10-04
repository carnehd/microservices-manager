import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BrunoCollection, BrunoRequest, HttpResponse, ServiceInfo } from '../../../shared/types'
import { api } from '../api'
import { decodeJwt, setToken, useAuthToken } from '../auth'

type Notify = (t: string, k?: 'error' | 'info' | 'success') => void
type KV = { key: string; value: string }
type Auth = { type: string; token: string; username: string; password: string }
type ReqTab = 'params' | 'body' | 'headers' | 'auth'
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const METHOD_TONE: Record<string, string> = { GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'delete' }

function subst(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k] : m))
}
function missingVars(text: string, vars: Record<string, string>): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((m) => m[1]))].filter((k) => !(k in vars))
}
function toRows(obj: Record<string, string>): KV[] {
  return Object.entries(obj).map(([key, value]) => ({ key, value }))
}
/** Se a resposta for um pull do Pub/Sub, descodifica o data (base64) de cada mensagem. */
function decodePubsubPull(body: string): Array<{ data: string; attributes?: Record<string, string>; messageId?: string }> | null {
  try {
    const d = JSON.parse(body) as { receivedMessages?: Array<{ message?: { data?: string; attributes?: Record<string, string>; messageId?: string } }> }
    if (!Array.isArray(d?.receivedMessages)) return null
    return d.receivedMessages.map((m) => ({
      data: m.message?.data ? decodeURIComponent(escape(atob(m.message.data))) : '',
      attributes: m.message?.attributes,
      messageId: m.message?.messageId
    }))
  } catch {
    return null
  }
}

function pretty(body: string, ct?: string): string {
  if (body && (ct?.includes('json') || /^\s*[[{]/.test(body))) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2)
    } catch {
      /* não é JSON */
    }
  }
  return body
}

/** Editor de pares chave/valor (para Params e Headers): adicionar, editar e remover. */
function KvRows({ rows, onChange, label }: { rows: KV[]; onChange: (r: KV[]) => void; label: string }) {
  const set = (i: number, patch: Partial<KV>): void => onChange(rows.map((h, idx) => (idx === i ? { ...h, ...patch } : h)))
  const add = (): void => onChange([...rows, { key: '', value: '' }])
  const remove = (i: number): void => onChange(rows.filter((_, idx) => idx !== i))
  return (
    <section>
      <div className="row">
        <span className="muted small">{rows.length} {label.toLowerCase()}{rows.length === 1 ? '' : 's'}</span>
        <span className="grow" />
        <button className="btn btn-sm" onClick={add}>+ {label}</button>
      </div>
      {rows.length === 0 && <div className="muted small">No {label.toLowerCase()}s — add one with “+ {label}”.</div>}
      {rows.map((h, i) => (
        <div className="row bruno-header" key={i}>
          <input className="input mono bruno-hkey" placeholder="Name" value={h.key} onChange={(e) => set(i, { key: e.target.value })} spellCheck={false} />
          <input className="input mono grow" placeholder="Value" value={h.value} onChange={(e) => set(i, { value: e.target.value })} spellCheck={false} />
          <button className="btn btn-sm" onClick={() => remove(i)} title="remove">✕</button>
        </div>
      ))}
    </section>
  )
}

function loadTokenForm(): { realm?: string; clientId?: string; username?: string } {
  try {
    return JSON.parse(localStorage.getItem('msm.tokenForm') ?? '{}')
  } catch {
    return {}
  }
}

/** Password grant contra o Keycloak local; o token fica partilhado por todos os serviços. */
function KeycloakTokenForm({ kcPort, notify }: { kcPort: number; notify: Notify }) {
  const saved = loadTokenForm()
  const [realm, setRealm] = useState(saved.realm ?? 'master')
  const [clientId, setClientId] = useState(saved.clientId ?? 'admin-cli')
  const [username, setUsername] = useState(saved.username ?? '')
  const [password, setPassword] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [busy, setBusy] = useState(false)

  const get = async (): Promise<void> => {
    setBusy(true)
    try {
      const form = new URLSearchParams({ grant_type: 'password', client_id: clientId, username, password })
      if (clientSecret) form.set('client_secret', clientSecret)
      const r = await api.http({
        method: 'POST',
        url: `http://localhost:${kcPort}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString()
      })
      if (r.error) throw new Error(`Keycloak not responding at localhost:${kcPort}: ${r.error}`)
      let j: { access_token?: string; expires_in?: number; error?: string; error_description?: string } = {}
      try {
        j = JSON.parse(r.body)
      } catch {
        /* resposta não JSON */
      }
      if (r.status !== 200 || !j.access_token) throw new Error(j.error_description ?? j.error ?? `HTTP ${r.status}`)
      setToken(j.access_token)
      try {
        localStorage.setItem('msm.tokenForm', JSON.stringify({ realm, clientId, username }))
      } catch {
        /* ignore */
      }
      notify(`Token obtained for ${username} (expires in ${j.expires_in ?? '?'} s)`, 'success')
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="form form-row">
      <label>Realm<input className="input" value={realm} onChange={(e) => setRealm(e.target.value)} /></label>
      <label>Client ID<input className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} /></label>
      <label>Username<input className="input" value={username} onChange={(e) => setUsername(e.target.value)} /></label>
      <label>Password<input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && get()} /></label>
      <label>Client secret (optional)<input className="input" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></label>
      <button className="btn btn-primary" disabled={busy || !username} onClick={get}>{busy ? 'Obtaining…' : 'Get token'}</button>
      <span className="muted small">Direct access grants must be enabled on the client.</span>
    </div>
  )
}

export function BrunoView({ svc, kcPort, notify, fail }: { svc: ServiceInfo; kcPort: number; notify: Notify; fail: (e: unknown) => void }) {
  const [cols, setCols] = useState<BrunoCollection[] | null>(null)
  const [colDir, setColDir] = useState('')
  const [env, setEnv] = useState('')
  const [sel, setSel] = useState<BrunoRequest | null>(null)
  const [resp, setResp] = useState<HttpResponse | null>(null)
  const [sending, setSending] = useState(false)
  const [showHeaders, setShowHeaders] = useState(false)
  const [reqTab, setReqTab] = useState<ReqTab>('params')
  const [methodEdit, setMethodEdit] = useState('GET')
  const [urlEdit, setUrlEdit] = useState('')
  const [bodyEdit, setBodyEdit] = useState('')
  const [headersEdit, setHeadersEdit] = useState<KV[]>([])
  const [paramsEdit, setParamsEdit] = useState<KV[]>([])
  const [auth, setAuth] = useState<Auth>({ type: 'none', token: '', username: '', password: '' })
  const kcToken = useAuthToken()

  const load = useCallback(async () => {
    try {
      const c = await api.bruno(svc.id)
      setCols(c)
      setColDir((cur) => (cur && c.some((x) => x.dir === cur) ? cur : c[0]?.dir ?? ''))
    } catch (e) {
      fail(e)
    }
  }, [svc.id, fail])

  useEffect(() => {
    void load()
  }, [load])

  const col = cols?.find((c) => c.dir === colDir) ?? cols?.[0]
  useEffect(() => {
    if (col) setEnv((cur) => (col.environments.some((e) => e.name === cur) ? cur : col.environments.find((e) => /local/i.test(e.name))?.name ?? col.environments[0]?.name ?? ''))
    setSel(null)
    setResp(null)
  }, [col])

  const vars = useMemo(() => Object.fromEntries((col?.environments.find((e) => e.name === env)?.vars ? Object.entries(col.environments.find((e) => e.name === env)!.vars) : [])), [col, env])

  // Ao escolher um pedido, carrega método/url/params/body/headers/auth para os editores.
  useEffect(() => {
    if (!sel) return
    setMethodEdit(sel.method)
    setUrlEdit(sel.url)
    setBodyEdit(sel.body ?? '')
    setHeadersEdit(toRows(sel.headers))
    setParamsEdit(toRows(sel.params))
    setAuth(sel.auth ? { type: sel.auth.type, token: sel.auth.token ?? '', username: sel.auth.username ?? '', password: sel.auth.password ?? '' } : { type: 'none', token: '', username: '', password: '' })
    setResp(null)
    setReqTab(['POST', 'PUT', 'PATCH'].includes(sel.method) ? 'body' : 'params')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel])

  const bodyAllowed = !['GET', 'HEAD'].includes(methodEdit)
  const resolvedUrl = (): string => {
    const base = subst(urlEdit, vars)
    const q = paramsEdit.filter((p) => p.key.trim()).map((p) => `${encodeURIComponent(p.key.trim())}=${encodeURIComponent(subst(p.value, vars))}`)
    return q.length ? base + (base.includes('?') ? '&' : '?') + q.join('&') : base
  }

  const send = async (): Promise<void> => {
    if (!sel) return
    setSending(true)
    setResp(null)
    try {
      const headers: Record<string, string> = {}
      for (const { key, value } of headersEdit) if (key.trim()) headers[key.trim()] = subst(value, vars)
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'authorization')) {
        if (auth.type === 'bearer' && auth.token.trim()) headers.Authorization = `Bearer ${subst(auth.token, vars)}`
        else if (auth.type === 'basic' && (auth.username || auth.password)) headers.Authorization = `Basic ${btoa(`${subst(auth.username, vars)}:${subst(auth.password, vars)}`)}`
        else if (auth.type === 'keycloak' && kcToken) headers.Authorization = `Bearer ${kcToken}`
      }
      setResp(await api.http({ method: methodEdit, url: resolvedUrl(), headers, body: bodyAllowed && bodyEdit.trim() ? subst(bodyEdit, vars) : undefined }))
    } catch (e) {
      fail(e)
    } finally {
      setSending(false)
    }
  }

  if (!cols) return <div className="empty">Searching for Bruno collections…</div>
  if (!cols.length) {
    return (
      <div className="empty">
        <p>No Bruno collection found in this service.</p>
        <p className="muted small">A Bruno collection is a folder with <span className="mono">bruno.json</span> and <span className="mono">.bru</span> files. Create one in <a className="link" onClick={() => api.openExternal('https://www.usebruno.com')}>Bruno</a> inside the service folder.</p>
      </div>
    )
  }

  const missing = sel ? missingVars([urlEdit, bodyEdit, ...headersEdit.map((h) => h.value), ...paramsEdit.map((p) => p.value), auth.token].join(' '), vars) : []
  const formatJson = (): void => {
    try {
      setBodyEdit(JSON.stringify(JSON.parse(bodyEdit), null, 2))
    } catch {
      notify('The body is not valid JSON', 'error')
    }
  }
  const kcInfo = kcToken ? decodeJwt(kcToken) : null
  const grouped = new Map<string, BrunoRequest[]>()
  for (const r of col?.requests ?? []) grouped.set(r.folder, [...(grouped.get(r.folder) ?? []), r])

  return (
    <div className="endpoints">
      <div className="ep-list">
        <div className="ep-list-head">
          {cols.length > 1 ? (
            <select className="input grow" value={colDir} onChange={(e) => setColDir(e.target.value)}>
              {cols.map((c) => <option key={c.dir} value={c.dir}>{c.name} · {c.dir}</option>)}
            </select>
          ) : <span className="mono small grow ellipsis" title={col?.dir}>⧉ {col?.name}</span>}
          <button className="btn btn-sm" onClick={load} title="reload collections">⟳</button>
        </div>
        {col && col.environments.length > 0 && (
          <div className="ep-list-head" style={{ top: 44 }}>
            <label className="inline grow">Environment
              <select className="input grow" value={env} onChange={(e) => setEnv(e.target.value)}>
                {col.environments.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
              </select>
            </label>
          </div>
        )}
        {[...grouped.entries()].map(([folder, reqs]) => (
          <section key={folder || '.'}>
            {folder && <h4>{folder}</h4>}
            {reqs.map((r) => (
              <button key={r.file} className={`ep-item${sel?.file === r.file ? ' selected' : ''}`} onClick={() => { setSel(r); setResp(null) }} title={r.url}>
                <span className={`method method-${METHOD_TONE[r.method] ?? 'other'}`}>{r.method}</span>
                <span className="ep-path">{r.name}</span>
              </button>
            ))}
          </section>
        ))}
        {!col?.requests.length && <div className="muted pad small">Collection has no requests.</div>}
      </div>

      <div className="ep-main">
        {!sel && <div className="empty">Choose a request from the collection.</div>}
        {sel && (
          <>
            <div className="row bruno-urlbar">
              <select className={`input bruno-method method-${METHOD_TONE[methodEdit] ?? 'other'}`} value={methodEdit} onChange={(e) => setMethodEdit(e.target.value)}>
                {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <input className="input mono grow" value={urlEdit} onChange={(e) => setUrlEdit(e.target.value)} spellCheck={false} placeholder="http://localhost:8080/path" />
              <button className="btn btn-primary" disabled={sending} onClick={send}>{sending ? 'Sending…' : 'Send'}</button>
            </div>
            <div className="muted small mono ellipsis" title={resolvedUrl()}>→ {resolvedUrl()}</div>
            {missing.length > 0 && <div className="small" style={{ color: 'var(--amber)' }}>⚠ unresolved variables: {missing.map((v) => `{{${v}}}`).join(', ')} — choose the right environment</div>}

            <div className="tabs inline bruno-subtabs">
              <button className={reqTab === 'params' ? 'active' : ''} onClick={() => setReqTab('params')}>Params{paramsEdit.length ? ` (${paramsEdit.length})` : ''}</button>
              <button className={reqTab === 'body' ? 'active' : ''} onClick={() => setReqTab('body')}>Body</button>
              <button className={reqTab === 'headers' ? 'active' : ''} onClick={() => setReqTab('headers')}>Headers{headersEdit.length ? ` (${headersEdit.length})` : ''}</button>
              <button className={reqTab === 'auth' ? 'active' : ''} onClick={() => setReqTab('auth')}>Auth{auth.type !== 'none' ? ' •' : ''}</button>
            </div>

            {reqTab === 'params' && <KvRows rows={paramsEdit} onChange={setParamsEdit} label="Param" />}

            {reqTab === 'headers' && <KvRows rows={headersEdit} onChange={setHeadersEdit} label="Header" />}

            {reqTab === 'body' && (
              <section>
                <div className="row">
                  <span className="muted small">Body {sel.bodyType ? `(${sel.bodyType})` : ''}{!bodyAllowed ? ' — not sent for GET/HEAD' : ''}</span>
                  <span className="grow" />
                  <button className="btn btn-sm" onClick={formatJson} title="Format as JSON">Format JSON</button>
                  <button className="btn btn-sm" disabled={bodyEdit === (sel.body ?? '')} onClick={() => setBodyEdit(sel.body ?? '')} title="Reset to original body">Reset</button>
                </div>
                <textarea className="input mono bruno-body" value={bodyEdit} onChange={(e) => setBodyEdit(e.target.value)} spellCheck={false} placeholder="(no body — write the payload to send)" />
              </section>
            )}

            {reqTab === 'auth' && (
              <section>
                <label className="inline">Type
                  <select className="input" value={auth.type} onChange={(e) => setAuth((a) => ({ ...a, type: e.target.value }))}>
                    <option value="none">No Auth</option>
                    <option value="bearer">Bearer Token</option>
                    <option value="basic">Basic</option>
                    <option value="keycloak">Keycloak token</option>
                  </select>
                </label>
                {auth.type === 'bearer' && (
                  <input className="input mono" placeholder="token (supports {{var}})" value={auth.token} onChange={(e) => setAuth((a) => ({ ...a, token: e.target.value }))} spellCheck={false} />
                )}
                {auth.type === 'basic' && (
                  <div className="row">
                    <input className="input grow" placeholder="username" value={auth.username} onChange={(e) => setAuth((a) => ({ ...a, username: e.target.value }))} />
                    <input className="input grow" type="password" placeholder="password" value={auth.password} onChange={(e) => setAuth((a) => ({ ...a, password: e.target.value }))} />
                  </div>
                )}
                {auth.type === 'keycloak' && (
                  <>
                    <div className="row">
                      {kcToken
                        ? <span className="muted small">Active token{kcInfo?.username ? ` · ${kcInfo.username}` : ''}{kcInfo?.exp ? ` · expires ${new Date(kcInfo.exp * 1000).toLocaleTimeString()}` : ''}</span>
                        : <span className="muted small">No active token — get one below.</span>}
                      {kcToken && <button className="btn btn-sm" onClick={() => setToken('')}>Clear token</button>}
                    </div>
                    <KeycloakTokenForm kcPort={kcPort} notify={notify} />
                  </>
                )}
                {auth.type === 'none' && <span className="muted small">No authorization header is sent (unless you add one on the Headers tab).</span>}
              </section>
            )}

            <section>
              <h3>Response</h3>
              {!resp && <div className="muted small">No response yet.</div>}
              {resp?.error && <div className="text-error">No response: {resp.error}</div>}
              {resp && !resp.error && (
                <>
                  <div className="row">
                    <span className={`status status-${resp.status < 300 ? 'ok' : resp.status < 400 ? 'redir' : 'err'}`}>{resp.status} {resp.statusText}</span>
                    <span className="muted small">{resp.timeMs} ms · {resp.body.length} bytes{resp.headers['content-type'] ? ` · ${resp.headers['content-type']}` : ''}</span>
                    <span className="grow" />
                    <button className="btn btn-sm" onClick={() => setShowHeaders((v) => !v)}>{showHeaders ? 'Hide headers' : `Headers (${Object.keys(resp.headers).length})`}</button>
                  </div>
                  {showHeaders && <pre className="resp-body small">{Object.entries(resp.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}</pre>}
                  {(() => {
                    const events = decodePubsubPull(resp.body)
                    if (!events) return null
                    return (
                      <div className="pubsub-events">
                        <div className="muted small">Decoded Pub/Sub events: {events.length}</div>
                        {events.length === 0 && <div className="muted small">(no messages — create an operation first, or the message has already been read)</div>}
                        {events.map((e, i) => (
                          <div className="pubsub-event" key={(e.messageId ?? '') + i}>
                            <pre className="resp-body">{pretty(e.data, 'json')}</pre>
                            {e.attributes && Object.keys(e.attributes).length > 0 && <div className="muted small mono">attrs: {JSON.stringify(e.attributes)}</div>}
                          </div>
                        ))}
                      </div>
                    )
                  })()}
                  <pre className="resp-body">{pretty(resp.body, resp.headers['content-type']) || <span className="muted">(empty body)</span>}</pre>
                </>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
