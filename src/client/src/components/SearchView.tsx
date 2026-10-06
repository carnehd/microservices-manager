import { useMemo, useState } from 'react'
import type { SearchResult } from '../../../shared/types'
import { api } from '../api'

type Notify = (t: string, k?: 'error' | 'info' | 'success') => void
const DEFAULT_EXTS = 'java, yaml, yml, xml, properties, json, sql'

/** Pesquisa uma string nos ficheiros de todos os microserviços, filtrando por extensão. */
export function SearchView({ notify, fail }: { notify: Notify; fail: (e: unknown) => void }) {
  const [query, setQuery] = useState('')
  const [exts, setExts] = useState(DEFAULT_EXTS)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [ran, setRan] = useState('')

  const run = async (): Promise<void> => {
    if (!query.trim()) return
    setBusy(true)
    try {
      const r = await api.search(query.trim(), exts, caseSensitive)
      setResult(r)
      setRan(query.trim())
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  // Agrupa por serviço → ficheiro
  const grouped = useMemo(() => {
    const bySvc = new Map<string, Map<string, SearchResult['hits']>>()
    for (const h of result?.hits ?? []) {
      let svc = bySvc.get(h.service)
      if (!svc) { svc = new Map(); bySvc.set(h.service, svc) }
      const arr = svc.get(h.file) ?? []
      arr.push(h)
      svc.set(h.file, arr)
    }
    return [...bySvc.entries()]
  }, [result])

  const highlight = (text: string): React.ReactNode => {
    if (!ran) return text
    const q = caseSensitive ? ran : ran.toLowerCase()
    const hay = caseSensitive ? text : text.toLowerCase()
    const out: React.ReactNode[] = []
    let i = 0
    while (i < text.length) {
      const idx = hay.indexOf(q, i)
      if (idx < 0) { out.push(text.slice(i)); break }
      if (idx > i) out.push(text.slice(i, idx))
      out.push(<mark key={idx}>{text.slice(idx, idx + ran.length)}</mark>)
      i = idx + ran.length
    }
    return out
  }

  return (
    <main className="service search-view">
      <div className="svc-header"><div className="grow"><h2>Search in microservices</h2>
        <div className="muted small">Procura uma string nos ficheiros de todos os microserviços (ignora target/, .git, node_modules…).</div>
      </div></div>

      <div className="actions" style={{ flexWrap: 'wrap' }}>
        <input className="input mono grow" style={{ minWidth: 260 }} placeholder="texto a procurar…" value={query} autoFocus
          onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void run()} />
        <button className="btn btn-primary" disabled={busy || !query.trim()} onClick={() => void run()}>{busy ? 'Searching…' : '🔍 Search'}</button>
        <label className="check"><input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} /> case sensitive</label>
      </div>
      <div className="actions" style={{ flexWrap: 'wrap' }}>
        <label className="inline grow">File types
          <input className="input mono grow" value={exts} onChange={(e) => setExts(e.target.value)} placeholder="java, yaml, xml, … (vazio = todos)" title="Extensões separadas por vírgula. Vazio = todos os ficheiros de texto." />
        </label>
        <button className="btn btn-sm" onClick={() => setExts(DEFAULT_EXTS)}>reset</button>
        <button className="btn btn-sm" onClick={() => setExts('')}>all files</button>
      </div>

      <div className="tab-body">
        {!result && <div className="empty">Escreve uma string e carrega em <b>Search</b>.</div>}
        {result && (
          <div className="config">
            <p className="muted small">
              {result.hits.length} match{result.hits.length === 1 ? '' : 'es'} em {grouped.length} serviço(s) · {result.scanned} ficheiros lidos
              {result.truncated && <span style={{ color: 'var(--amber)' }}> · resultados cortados (limite atingido)</span>}
            </p>
            {grouped.map(([svc, files]) => (
              <section key={svc} className="search-svc">
                <h3>{svc} <span className="muted small">({[...files.values()].reduce((n, a) => n + a.length, 0)})</span></h3>
                {[...files.entries()].map(([file, hits]) => (
                  <div key={file} className="search-file">
                    <div className="row">
                      <span className="mono small grow ellipsis" title={hits[0].path}>{file}</span>
                      <button className="btn btn-sm" title="Open the file" onClick={() => void api.openPath(hits[0].path)}>open</button>
                    </div>
                    {hits.map((h) => (
                      <div key={h.line} className="search-hit mono small">
                        <span className="search-line">{h.line}</span>
                        <span className="search-text">{highlight(h.text)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </section>
            ))}
            {!result.hits.length && <div className="muted pad">Sem resultados para "{ran}".</div>}
          </div>
        )}
      </div>
    </main>
  )
}
