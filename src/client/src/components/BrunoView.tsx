import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BrunoCollection, BrunoRequest, HttpResponse, ServiceInfo } from '../../../shared/types'
import { api } from '../api'
import { setToken, useAuthToken } from '../auth'
import { Badge } from './common'

type Notify = (t: string, k?: 'error' | 'info' | 'success') => void
const METHOD_TONE: Record<string, string> = { GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'delete' }

function subst(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k] : m))
}
function missingVars(text: string, vars: Record<string, string>): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((m) => m[1]))].filter((k) => !(k in vars))
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

export function BrunoView({ svc, notify, fail }: { svc: ServiceInfo; notify: Notify; fail: (e: unknown) => void }) {
  const [cols, setCols] = useState<BrunoCollection[] | null>(null)
  const [colDir, setColDir] = useState('')
  const [env, setEnv] = useState('')
  const [sel, setSel] = useState<BrunoRequest | null>(null)
  const [useToken, setUseToken] = useState(true)
  const [resp, setResp] = useState<HttpResponse | null>(null)
  const [sending, setSending] = useState(false)
  const [showHeaders, setShowHeaders] = useState(false)
  const token = useAuthToken()

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

  const send = async (): Promise<void> => {
    if (!sel) return
    setSending(true)
    setResp(null)
    try {
      const url = subst(sel.url, vars)
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(sel.headers)) headers[k] = subst(v, vars)
      if (sel.auth?.type === 'bearer' && sel.auth.token) headers.Authorization = `Bearer ${subst(sel.auth.token, vars)}`
      if (useToken && token && !Object.keys(headers).some((h) => h.toLowerCase() === 'authorization')) headers.Authorization = `Bearer ${token}`
      const query = Object.entries(sel.params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(subst(v, vars))}`)
      const finalUrl = query.length ? url + (url.includes('?') ? '&' : '?') + query.join('&') : url
      setResp(await api.http({ method: sel.method, url: finalUrl, headers, body: sel.body ? subst(sel.body, vars) : undefined }))
    } catch (e) {
      fail(e)
    } finally {
      setSending(false)
    }
  }

  if (!cols) return <div className="empty">A procurar coleções Bruno…</div>
  if (!cols.length) {
    return (
      <div className="empty">
        <p>Nenhuma coleção Bruno encontrada neste serviço.</p>
        <p className="muted small">Uma coleção Bruno é uma pasta com <span className="mono">bruno.json</span> e ficheiros <span className="mono">.bru</span>. Cria uma no <a className="link" onClick={() => api.openExternal('https://www.usebruno.com')}>Bruno</a> dentro da pasta do serviço.</p>
      </div>
    )
  }

  const finalUrl = sel ? subst(sel.url, vars) : ''
  const missing = sel ? missingVars(sel.url + ' ' + (sel.body ?? '') + ' ' + Object.values(sel.headers).join(' '), vars) : []
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
          <button className="btn btn-sm" onClick={load} title="reler as coleções">⟳</button>
        </div>
        {col && col.environments.length > 0 && (
          <div className="ep-list-head" style={{ top: 44 }}>
            <label className="inline grow">Ambiente
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
        {!col?.requests.length && <div className="muted pad small">Coleção sem pedidos.</div>}
      </div>

      <div className="ep-main">
        {!sel && <div className="empty">Escolhe um pedido da coleção.</div>}
        {sel && (
          <>
            <div className="row">
              <span className={`method method-${METHOD_TONE[sel.method] ?? 'other'}`}>{sel.method}</span>
              <span className="mono small grow ellipsis" title={finalUrl}>{finalUrl}</span>
              <button className="btn btn-primary" disabled={sending} onClick={send}>{sending ? 'A enviar…' : 'Enviar'}</button>
            </div>
            {missing.length > 0 && <div className="small" style={{ color: 'var(--amber)' }}>⚠ variáveis por resolver: {missing.map((v) => `{{${v}}}`).join(', ')} — escolhe o ambiente certo</div>}
            <div className="row">
              <label className="check"><input type="checkbox" checked={useToken && !!token} disabled={!token} onChange={(e) => setUseToken(e.target.checked)} /> Authorization: Bearer (token do Keycloak)</label>
              {token ? <span className="muted small">token ativo</span> : <span className="muted small">sem token — obtém-o no separador Endpoints</span>}
              {token && <button className="btn btn-sm" onClick={() => setToken('')}>Limpar</button>}
            </div>
            {Object.keys(sel.headers).length > 0 && (
              <section>
                <h3>Headers</h3>
                <pre className="resp-body small">{Object.entries(sel.headers).map(([k, v]) => `${k}: ${subst(v, vars)}`).join('\n')}</pre>
              </section>
            )}
            {sel.body && (
              <section>
                <h3>Body {sel.bodyType && <span className="muted small">({sel.bodyType})</span>}</h3>
                <pre className="resp-body">{subst(sel.body, vars)}</pre>
              </section>
            )}
            <section>
              <h3>Resposta</h3>
              {!resp && <div className="muted small">Ainda sem resposta.</div>}
              {resp?.error && <div className="text-error">Sem resposta: {resp.error}</div>}
              {resp && !resp.error && (
                <>
                  <div className="row">
                    <span className={`status status-${resp.status < 300 ? 'ok' : resp.status < 400 ? 'redir' : 'err'}`}>{resp.status} {resp.statusText}</span>
                    <span className="muted small">{resp.timeMs} ms · {resp.body.length} bytes{resp.headers['content-type'] ? ` · ${resp.headers['content-type']}` : ''}</span>
                    <span className="grow" />
                    <button className="btn btn-sm" onClick={() => setShowHeaders((v) => !v)}>{showHeaders ? 'Esconder headers' : `Headers (${Object.keys(resp.headers).length})`}</button>
                  </div>
                  {showHeaders && <pre className="resp-body small">{Object.entries(resp.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}</pre>}
                  <pre className="resp-body">{pretty(resp.body, resp.headers['content-type']) || <span className="muted">(corpo vazio)</span>}</pre>
                </>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
