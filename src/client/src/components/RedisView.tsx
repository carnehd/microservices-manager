import { useCallback, useEffect, useState } from 'react'
import type { RedisInfo, RedisKeyMeta, RedisKeyValue } from '../../../shared/types'
import { api, FRESH, type ReqOpts } from '../api'
import { Badge, ContainerHeader } from './common'

type Notify = (t: string, k?: 'error' | 'info' | 'success') => void
const TYPE_TONE: Record<string, 'blue' | 'green' | 'amber' | 'purple' | 'muted' | 'red'> = { string: 'blue', hash: 'green', list: 'amber', set: 'purple', zset: 'purple', stream: 'muted' }

function fmtTtl(ttl: number): string {
  if (ttl === -1) return 'no expiry'
  if (ttl === -2) return 'does not exist'
  if (ttl < 60) return `${ttl} s`
  if (ttl < 3600) return `${Math.floor(ttl / 60)} min ${ttl % 60} s`
  return `${Math.floor(ttl / 3600)} h ${Math.floor((ttl % 3600) / 60)} min`
}

function pretty(v: unknown): string {
  if (typeof v === 'string') {
    try {
      return JSON.stringify(JSON.parse(v), null, 2)
    } catch {
      return v
    }
  }
  return JSON.stringify(v, null, 2)
}

/** Como pretty(), mas também abre JSON guardado como string DENTRO de listas/hashes/sets (ex.: mensagens em cache). */
function prettyDeep(v: unknown): string {
  const open = (x: unknown): unknown => {
    if (typeof x === 'string') {
      const s = x.trim()
      if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
        try { return JSON.parse(s) } catch { return x }
      }
      return x
    }
    if (Array.isArray(x)) return x.map(open)
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, y]) => [k, open(y)]))
    return x
  }
  if (typeof v === 'string') return pretty(v)
  return JSON.stringify(open(v), null, 2)
}

export function RedisView({ notify, fail }: { notify: Notify; fail: (e: unknown) => void }) {
  const [info, setInfo] = useState<RedisInfo | null>(null)
  const [pattern, setPattern] = useState('*')
  const [keys, setKeys] = useState<RedisKeyMeta[]>([])
  const [cursor, setCursor] = useState('0')
  const [selected, setSelected] = useState<RedisKeyValue | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [newKey, setNewKey] = useState({ key: '', value: '', ttl: '' })
  const [ttlEdit, setTtlEdit] = useState('')
  const [cmd, setCmd] = useState('')
  const [cmdOut, setCmdOut] = useState<string>('')
  const [showNew, setShowNew] = useState(false)

  // Sem opções lê a cache do servidor (entrar é instantâneo); FRESH re-corre os comandos.
  const refreshInfo = useCallback(async (o?: ReqOpts) => {
    try {
      setInfo(await api.redis.info(o))
    } catch (e) {
      fail(e)
    }
  }, [fail])

  const search = useCallback(async (fromCursor = '0') => {
    setBusy('scan')
    try {
      const r = await api.redis.keys(pattern, fromCursor)
      setKeys((prev) => (fromCursor === '0' ? r.keys : [...prev, ...r.keys]))
      setCursor(r.cursor)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }, [pattern, fail])

  useEffect(() => {
    void refreshInfo()
  }, [refreshInfo])

  useEffect(() => {
    if (info?.connected) void search('0')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.connected])

  const open = async (key: string): Promise<void> => {
    try {
      const v = await api.redis.get(key)
      setSelected(v)
      setTtlEdit(v.ttl > 0 ? String(v.ttl) : '')
    } catch (e) {
      fail(e)
    }
  }

  const act = async (label: string, fn: () => Promise<unknown>, done?: string, reload = true): Promise<void> => {
    setBusy(label)
    try {
      const r = await fn()
      if (done) notify(typeof r === 'string' && label === 'container' ? r : done, 'success')
      if (reload) {
        await refreshInfo()
        await search('0')
      }
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  // Criar/arrancar o container: o Redis pode demorar a aceitar ligações, por isso espera-se
  // (com retries) até estar connected antes de actualizar o estado e listar as chaves.
  const startRedisContainer = async (): Promise<void> => {
    setBusy('container')
    try {
      const r = await api.redis.startContainer()
      notify(typeof r === 'string' ? r : 'Redis container started', 'success')
      // à espera do estado mudar: tem de ignorar a cache em cada tentativa
      let next = await api.redis.info(FRESH)
      for (let i = 0; i < 16 && !next.connected; i++) {
        await new Promise((res) => setTimeout(res, 500))
        next = await api.redis.info(FRESH)
      }
      setInfo(next)
      if (next.connected) await search('0')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const runCmd = async (): Promise<void> => {
    if (!cmd.trim()) return
    setBusy('cmd')
    try {
      const r = await api.redis.command(cmd)
      setCmdOut(prettyDeep(r ?? '(nil)'))
      await refreshInfo()
      await search('0')
    } catch (e) {
      setCmdOut(`ERROR: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const connected = !!info?.connected
  const ct = info?.container

  return (
    <main className="service">
      <ContainerHeader
        title="Redis"
        onRefresh={() => Promise.all([refreshInfo(FRESH), search('0')])} refreshTitle="Refresh — re-run the commands that check Redis and its container"
        container={ct?.name ?? '—'} image={ct?.image}
        state={!ct ? 'unknown' : ct.running ? 'running' : ct.exists ? 'stopped' : 'missing'}
        port={info?.port}
        error={info?.error}
        note={info ? <>{info.host}:{info.port} · db {info.db}{connected && <> · v{info.version} · {info.keys} keys · {info.usedMemory} · {info.clients} clients · hits {info.hits} / misses {info.misses}</>}</> : 'connecting…'}
      >
        <Badge tone={connected ? 'green' : 'red'}>{connected ? 'connected' : 'not connected'}</Badge>
      </ContainerHeader>

      <div className="actions">
        {ct && !ct.running && (
          <button className="btn btn-primary" disabled={!!busy} onClick={() => void startRedisContainer()}>
            {busy === 'container' ? 'Starting…' : ct.exists ? `▶ Start container ${ct.name}` : `▶ Create and start container ${ct.name}`}
          </button>
        )}
        <button className="btn" disabled={!connected} onClick={() => setShowNew((v) => !v)}>+ New key</button>
        <span className="grow" />
        <button className="btn btn-danger" disabled={!connected || !!busy}
          onClick={() => { if (confirm(`Delete ALL keys in db ${info?.db}?`)) void act('flush', api.redis.flush, 'Database cleared') }}>Flush DB</button>
      </div>

      {showNew && (
        <div className="actions">
          <input className="input mono" placeholder="key" value={newKey.key} onChange={(e) => setNewKey({ ...newKey, key: e.target.value })} />
          <input className="input mono grow" placeholder="value (string or JSON)" value={newKey.value} onChange={(e) => setNewKey({ ...newKey, value: e.target.value })} />
          <input className="input" style={{ width: 110 }} type="number" placeholder="TTL (s)" value={newKey.ttl} onChange={(e) => setNewKey({ ...newKey, ttl: e.target.value })} />
          <button className="btn btn-primary" disabled={!newKey.key.trim() || !!busy}
            onClick={() => act('set', () => api.redis.set(newKey.key.trim(), newKey.value, Number(newKey.ttl) || undefined), `Key ${newKey.key} saved`).then(() => { setShowNew(false); setNewKey({ key: '', value: '', ttl: '' }) })}>Save</button>
        </div>
      )}

      <div className="tab-body">
        {!connected ? (
          <div className="empty">
            <p>No connection to Redis at {info?.host}:{info?.port}.</p>
            <p className="muted small">Start the container above, or adjust host/port/password in Settings → Redis.</p>
          </div>
        ) : (
          <div className="endpoints">
            <div className="ep-list">
              <div className="ep-list-head">
                <input className="input mono grow" placeholder="pattern (e.g. sessao:*)" value={pattern} onChange={(e) => setPattern(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search('0')} />
                <button className="btn btn-sm" disabled={!!busy} onClick={() => search('0')}>Search</button>
              </div>
              {keys.map((k) => (
                <button key={k.key} className={`ep-item${selected?.key === k.key ? ' selected' : ''}`} onClick={() => open(k.key)} title={`${k.type} · ${fmtTtl(k.ttl)}`}>
                  <span className={`method method-${TYPE_TONE[k.type] === 'blue' ? 'post' : TYPE_TONE[k.type] === 'green' ? 'get' : TYPE_TONE[k.type] === 'amber' ? 'put' : 'patch'}`}>{k.type}</span>
                  <span className="ep-path mono">{k.key}</span>
                  {k.ttl > 0 && <span className="muted small" style={{ marginLeft: 'auto' }}>⏱</span>}
                </button>
              ))}
              {!keys.length && <div className="muted pad small">No keys for "{pattern}".</div>}
              {cursor !== '0' && <button className="btn btn-sm" style={{ margin: 8 }} disabled={!!busy} onClick={() => search(cursor)}>More…</button>}
              <div className="muted pad small">{keys.length} key(s) shown · SCAN{cursor !== '0' ? ' (more available)' : ''}</div>
            </div>

            <div className="ep-main">
              {!selected && <div className="empty">Select a key to view its value.</div>}
              {selected && (
                <>
                  <div className="row" style={{ flexWrap: 'wrap' }}>
                    <span className="mono" style={{ fontSize: 15 }}>{selected.key}</span>
                    <Badge tone={TYPE_TONE[selected.type] ?? 'muted'}>{selected.type}</Badge>
                    {selected.length !== undefined && <span className="muted small">{selected.length} element(s)</span>}
                    {selected.memory !== undefined && <span className="muted small">{selected.memory} bytes</span>}
                    <span className="grow" />
                    <button className="btn btn-sm" onClick={() => open(selected.key)}>⟳</button>
                    <button className="btn btn-sm btn-danger" disabled={!!busy}
                      onClick={() => { if (confirm(`Delete the key ${selected.key}?`)) void act('del', () => api.redis.del([selected.key]), 'Key deleted').then(() => setSelected(null)) }}>Delete</button>
                  </div>
                  <div className="row">
                    <span className="muted small">TTL: {fmtTtl(selected.ttl)}</span>
                    <input className="input" style={{ width: 120 }} type="number" placeholder="new TTL (s)" value={ttlEdit} onChange={(e) => setTtlEdit(e.target.value)} />
                    <button className="btn btn-sm" disabled={!!busy} onClick={() => act('ttl', () => api.redis.expire(selected.key, Number(ttlEdit) || 0), Number(ttlEdit) > 0 ? 'TTL set' : 'Expiry removed', false).then(() => open(selected.key))}>
                      {Number(ttlEdit) > 0 ? 'Set TTL' : 'Remove expiry'}
                    </button>
                  </div>
                  {selected.type === 'string' ? (
                    <StringEditor kv={selected} busy={!!busy} onSave={(v) => act('set', () => api.redis.set(selected.key, v), 'Value saved', false).then(() => open(selected.key))} />
                  ) : (
                    <pre className="resp-body">{prettyDeep(selected.value)}</pre>
                  )}
                </>
              )}

              <section>
                <h3>Console</h3>
                <div className="row">
                  <input className="input mono grow" placeholder="e.g. HGETALL user:1 · KEYS session:* · INFO memory" value={cmd} onChange={(e) => setCmd(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runCmd()} />
                  <button className="btn btn-sm btn-primary" disabled={!!busy || !cmd.trim()} onClick={runCmd}>Run</button>
                </div>
                {cmdOut && <pre className="resp-body">{cmdOut}</pre>}
              </section>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}

function StringEditor({ kv, busy, onSave }: { kv: RedisKeyValue; busy: boolean; onSave: (v: string) => Promise<void> }) {
  const raw = typeof kv.value === 'string' ? kv.value : ''
  // Abre já formatado quando é JSON válido (só espaços/quebras — o valor é o mesmo); formatar não conta como alteração.
  const [text, setText] = useState(pretty(raw))
  useEffect(() => setText(pretty(raw)), [raw])
  const isJson = (s: string): boolean => { try { JSON.parse(s); return true } catch { return false } }
  const dirty = text !== raw && text !== pretty(raw)
  return (
    <div>
      <textarea className="input mono" rows={Math.min(20, Math.max(4, text.split('\n').length + 1))} style={{ width: '100%' }} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <div className="row">
        <span className="muted small">{isJson(text) ? 'valid JSON' : ''}</span>
        <span className="grow" />
        <button className="btn btn-sm" disabled={!isJson(text) || text === pretty(text)} onClick={() => setText(pretty(text))} title="Pretty-print the JSON">Format JSON</button>
        <button className="btn btn-sm" disabled={!dirty} onClick={() => setText(pretty(raw))}>Reset</button>
        <button className="btn btn-sm btn-primary" disabled={!dirty || busy} onClick={() => onSave(text)}>Save value</button>
      </div>
    </div>
  )
}
