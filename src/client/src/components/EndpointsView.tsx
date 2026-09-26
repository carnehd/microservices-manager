import { useCallback, useEffect, useMemo, useState } from 'react'
import type { HttpResponse, ServiceInfo } from '../../../shared/types'
import { api } from '../api'
import { decodeJwt, setToken, useAuthToken } from '../auth'
import { parseOpenApi, type Operation } from '../openapi'

type Notify = (t: string, k?: 'error' | 'info' | 'success') => void
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const METHOD_TONE: Record<string, string> = { GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'delete' }

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const i = raw.indexOf(':')
    if (i > 0) out[raw.slice(0, i).trim()] = raw.slice(i + 1).trim()
  }
  return out
}

function hasHeader(h: Record<string, string>, name: string): boolean {
  return Object.keys(h).some((k) => k.toLowerCase() === name.toLowerCase())
}

function pretty(body: string, contentType?: string): string {
  if (!body) return ''
  if (contentType?.includes('json') || /^\s*[[{]/.test(body)) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2)
    } catch {
      /* não é JSON */
    }
  }
  return body
}

function tokenSummary(token: string): string {
  const info = decodeJwt(token)
  if (!info) return 'token (não é JWT)'
  const left = info.exp ? Math.round((info.exp * 1000 - Date.now()) / 60000) : undefined
  const exp = left === undefined ? '' : left < 0 ? ' · expirado' : ` · expira em ${left} min`
  return `${info.username ?? '?'}${exp}`
}

export function EndpointsView({
  svc, baseUrl, running, kcPort, notify
}: { svc: ServiceInfo; baseUrl: string; running: boolean; kcPort: number; notify: Notify }) {
  const [ops, setOps] = useState<Operation[] | null>(null)
  const [specError, setSpecError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [sel, setSel] = useState<Operation | null>(null)
  const [method, setMethod] = useState('GET')
  const [path, setPath] = useState('/')
  const [params, setParams] = useState<Record<string, string>>({})
  const [headersText, setHeadersText] = useState('')
  const [body, setBody] = useState('')
  const [resp, setResp] = useState<HttpResponse | null>(null)
  const [sending, setSending] = useState(false)
  const [showAuth, setShowAuth] = useState(false)
  const [apiGroups, setApiGroups] = useState<Array<{ name: string; url: string }>>([])
  const [apiGroup, setApiGroup] = useState<string>('')
  const [useToken, setUseToken] = useState(true)
  const token = useAuthToken()

  const loadSpec = useCallback(async (groupName?: string) => {
    setSpecError(null)
    setOps(null)
    const docsPath = svc.apiDocsPath ?? '/v3/api-docs'
    // Vários Swaggers no mesmo serviço (grupos springdoc): /v3/api-docs/swagger-config lista-os
    let candidates: string[] = [...new Set([docsPath, '/v3/api-docs', '/v2/api-docs'])]
    const cfg = await api.http({ method: 'GET', url: baseUrl + docsPath + '/swagger-config' })
    if (cfg.status === 200) {
      try {
        const urls = (JSON.parse(cfg.body).urls ?? []) as Array<{ name: string; url: string }>
        setApiGroups(urls)
        if (urls.length) {
          const pick = urls.find((u) => u.name === (groupName ?? apiGroup)) ?? urls[0]
          setApiGroup(pick.name)
          candidates = [pick.url]
        }
      } catch {
        setApiGroups([])
      }
    } else setApiGroups([])
    for (const p of candidates) {
      const r = await api.http({ method: 'GET', url: /^https?:/.test(p) ? p : baseUrl + p })
      if (r.status !== 200) continue
      try {
        setOps(parseOpenApi(JSON.parse(r.body)))
      } catch {
        setOps([])
        setSpecError(`OpenAPI inválido em ${p}`)
      }
      return
    }
    setOps([])
    setSpecError('Sem OpenAPI em /v3/api-docs — usa o pedido livre.')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, svc.apiDocsPath])

  // Carrega o OpenAPI mesmo que o serviço não tenha sido arrancado pela app (pode estar a correr no IDE)
  useEffect(() => {
    void loadSpec()
  }, [running, loadSpec])

  const choose = (op: Operation | null): void => {
    setSel(op)
    setResp(null)
    if (!op) {
      setMethod('GET')
      setPath('/')
      setParams({})
      setBody('')
      setHeadersText('')
      return
    }
    setMethod(op.method)
    setPath(op.path)
    setParams(Object.fromEntries(op.params.map((p) => [`${p.in}:${p.name}`, p.example])))
    setBody(op.bodyExample ?? '')
    setHeadersText(op.bodyContentType ? `Content-Type: ${op.bodyContentType}` : '')
  }

  const url = useMemo(() => {
    let p = path.replace(/\{([^}]+)\}/g, (m, name: string) => {
      const v = params[`path:${name}`]
      return v ? encodeURIComponent(v) : m
    })
    const q = Object.entries(params)
      .filter(([k, v]) => k.startsWith('query:') && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k.slice(6))}=${encodeURIComponent(v)}`)
    if (q.length) p += (p.includes('?') ? '&' : '?') + q.join('&')
    return /^https?:\/\//i.test(p) ? p : baseUrl + p
  }, [baseUrl, path, params])

  const buildHeaders = (): Record<string, string> => {
    const h = parseHeaders(headersText)
    for (const [k, v] of Object.entries(params)) if (k.startsWith('header:') && v) h[k.slice(7)] = v
    if (useToken && token && !hasHeader(h, 'authorization')) h.Authorization = `Bearer ${token}`
    if (body && !hasHeader(h, 'content-type')) h['Content-Type'] = 'application/json'
    return h
  }

  const send = async (): Promise<void> => {
    setSending(true)
    try {
      setResp(await api.http({ method, url, headers: buildHeaders(), body: body || undefined }))
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setSending(false)
    }
  }

  const copyCurl = async (): Promise<void> => {
    const parts = [
      `curl -X ${method}`,
      ...Object.entries(buildHeaders()).map(([k, v]) => `-H '${k}: ${v}'`),
      body ? `-d '${body.replace(/'/g, "'\\''")}'` : '',
      `'${url}'`
    ].filter(Boolean)
    try {
      await navigator.clipboard.writeText(parts.join(' \\\n  '))
      notify('Comando curl copiado', 'success')
    } catch {
      notify('Não consegui copiar para a área de transferência', 'error')
    }
  }

  const f = filter.trim().toLowerCase()
  const shown = (ops ?? []).filter((o) => !f || `${o.method} ${o.path} ${o.summary ?? ''} ${o.tags.join(' ')}`.toLowerCase().includes(f))
  const groups = new Map<string, Operation[]>()
  for (const o of shown) for (const t of o.tags) groups.set(t, [...(groups.get(t) ?? []), o])
  const hasBody = method !== 'GET' && method !== 'HEAD'

  return (
    <div className="endpoints">
      <div className="ep-list">
        <div className="ep-list-head">
          <input className="input grow" placeholder="filtrar…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="btn btn-sm" onClick={() => loadSpec()} title="Recarregar OpenAPI">⟳</button>
        </div>
        {apiGroups.length > 0 && (
          <div className="ep-list-head" style={{ top: 44 }}>
            <label className="inline grow">API
              <select className="input grow" value={apiGroup} onChange={(e) => { setApiGroup(e.target.value); void loadSpec(e.target.value) }} title="Grupos Swagger deste serviço (springdoc)">
                {apiGroups.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
              </select>
            </label>
          </div>
        )}
        <button className={`ep-item${sel === null ? ' selected' : ''}`} onClick={() => choose(null)}>
          <span className="method method-any">ANY</span>
          <span className="ep-path">Pedido livre</span>
        </button>
        {ops === null && <div className="muted pad small">A ler OpenAPI…</div>}
        {specError && <div className="muted pad small">{specError}</div>}
        {[...groups.entries()].map(([tag, list]) => (
          <section key={tag}>
            <h4>{tag}</h4>
            {list.map((o) => (
              <button key={o.id} className={`ep-item${sel?.id === o.id ? ' selected' : ''}`} onClick={() => choose(o)} title={o.summary}>
                <span className={`method method-${METHOD_TONE[o.method] ?? 'other'}`}>{o.method}</span>
                <span className="ep-path mono">{o.path}</span>
              </button>
            ))}
          </section>
        ))}
      </div>

      <div className="ep-main">
        {!running && <div className="muted small">O serviço não foi arrancado por esta app — os pedidos vão na mesma para {baseUrl}.</div>}
        {sel?.summary && <div className="muted">{sel.summary}</div>}
        <div className="row">
          <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map((m) => <option key={m}>{m}</option>)}
          </select>
          <input
            className="input mono grow"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder="/api/… ou http://…"
          />
          <button className="btn btn-primary" disabled={sending} onClick={send}>{sending ? 'A enviar…' : 'Enviar'}</button>
          <button className="btn" onClick={copyCurl} title="Copiar como comando curl">curl</button>
        </div>
        <div className="muted small mono ellipsis" title={url}>{url}</div>

        {sel && sel.params.length > 0 && (
          <section>
            <h3>Parâmetros</h3>
            <table className="kv">
              <tbody>
                {sel.params.map((p) => (
                  <tr key={`${p.in}:${p.name}`}>
                    <th>{p.name} <span className="muted">{p.in}{p.required ? ' *' : ''}</span></th>
                    <td>
                      <input
                        className="input mono"
                        value={params[`${p.in}:${p.name}`] ?? ''}
                        onChange={(e) => setParams({ ...params, [`${p.in}:${p.name}`]: e.target.value })}
                        placeholder={p.description}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <section>
          <div className="row">
            <label className="check">
              <input type="checkbox" checked={useToken && !!token} disabled={!token} onChange={(e) => setUseToken(e.target.checked)} /> Authorization: Bearer
            </label>
            <span className="muted small grow">{token ? tokenSummary(token) : 'sem token'}</span>
            <button className="btn btn-sm" onClick={() => setShowAuth((v) => !v)}>{showAuth ? 'Fechar' : 'Obter token do Keycloak…'}</button>
            {token && <button className="btn btn-sm" onClick={() => setToken('')}>Limpar token</button>}
          </div>
          {showAuth && <TokenForm kcPort={kcPort} notify={notify} onDone={() => setShowAuth(false)} />}
        </section>

        <section>
          <h3>Headers</h3>
          <textarea className="input mono" rows={2} value={headersText} onChange={(e) => setHeadersText(e.target.value)} placeholder={'Content-Type: application/json\nX-Custom: valor'} />
        </section>

        {hasBody && (
          <section>
            <h3>Body</h3>
            <textarea className="input mono" rows={8} value={body} onChange={(e) => setBody(e.target.value)} placeholder="{ }" />
          </section>
        )}

        <section>
          <h3>Resposta</h3>
          {resp ? <ResponseView r={resp} /> : <div className="muted small">Ainda sem resposta.</div>}
        </section>
      </div>
    </div>
  )
}

function ResponseView({ r }: { r: HttpResponse }) {
  const [showHeaders, setShowHeaders] = useState(false)
  if (r.error) return <div className="text-error">Sem resposta: {r.error}</div>
  const tone = r.status < 300 ? 'ok' : r.status < 400 ? 'redir' : 'err'
  const ct = r.headers['content-type']
  const text = pretty(r.body, ct)
  return (
    <div className="response">
      <div className="row">
        <span className={`status status-${tone}`}>{r.status} {r.statusText}</span>
        <span className="muted small">{r.timeMs} ms · {r.body.length} bytes{ct ? ` · ${ct}` : ''}</span>
        <span className="grow" />
        <button className="btn btn-sm" onClick={() => setShowHeaders((v) => !v)}>
          {showHeaders ? 'Esconder headers' : `Headers (${Object.keys(r.headers).length})`}
        </button>
      </div>
      {showHeaders && <pre className="resp-body small">{Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}</pre>}
      <pre className="resp-body">{text || <span className="muted">(corpo vazio)</span>}</pre>
    </div>
  )
}

function loadForm(): { realm?: string; clientId?: string; username?: string } {
  try {
    return JSON.parse(localStorage.getItem('msm.tokenForm') ?? '{}')
  } catch {
    return {}
  }
}

/** Password grant contra o Keycloak local; o token fica partilhado por todos os serviços. */
function TokenForm({ kcPort, notify, onDone }: { kcPort: number; notify: Notify; onDone: () => void }) {
  const saved = loadForm()
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
      if (r.error) throw new Error(`Keycloak não responde em localhost:${kcPort}: ${r.error}`)
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
      notify(`Token obtido para ${username} (expira em ${j.expires_in ?? '?'} s)`, 'success')
      onDone()
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
      <label>Utilizador<input className="input" value={username} onChange={(e) => setUsername(e.target.value)} /></label>
      <label>Password<input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && get()} /></label>
      <label>Client secret (opcional)<input className="input" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></label>
      <button className="btn btn-primary" disabled={busy || !username} onClick={get}>{busy ? 'A obter…' : 'Obter token'}</button>
      <span className="muted small">Direct access grants tem de estar ativo no client.</span>
    </div>
  )
}
