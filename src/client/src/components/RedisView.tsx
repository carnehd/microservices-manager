import { useCallback, useEffect, useState } from 'react'
import type { RedisInfo, RedisKeyMeta, RedisKeyValue } from '../../../shared/types'
import { api } from '../api'
import { Badge } from './common'

type Notify = (t: string, k?: 'error' | 'info' | 'success') => void
const TYPE_TONE: Record<string, 'blue' | 'green' | 'amber' | 'purple' | 'muted' | 'red'> = { string: 'blue', hash: 'green', list: 'amber', set: 'purple', zset: 'purple', stream: 'muted' }

function fmtTtl(ttl: number): string {
  if (ttl === -1) return 'sem expiração'
  if (ttl === -2) return 'não existe'
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

  const refreshInfo = useCallback(async () => {
    try {
      setInfo(await api.redis.info())
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

  const runCmd = async (): Promise<void> => {
    if (!cmd.trim()) return
    setBusy('cmd')
    try {
      const r = await api.redis.command(cmd)
      setCmdOut(pretty(r ?? '(nil)'))
      await refreshInfo()
      await search('0')
    } catch (e) {
      setCmdOut(`ERRO: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const connected = !!info?.connected
  const ct = info?.container

  return (
    <main className="service">
      <div className="svc-header">
        <div className="grow">
          <h2>Redis <Badge tone={connected ? 'green' : 'red'}>{connected ? 'ligado' : 'sem ligação'}</Badge></h2>
          <div className="muted small">
            {info ? `${info.host}:${info.port} · db ${info.db}` : 'a ligar…'}
            {connected && <> · v{info!.version} · {info!.keys} chaves · {info!.usedMemory} · {info!.clients} clientes · hits {info!.hits} / misses {info!.misses}</>}
            {info?.error && <span className="text-error"> · {info.error}</span>}
            {ct && <> · container <b>{ct.name}</b> {ct.running ? 'a correr' : ct.exists ? 'parado' : 'não existe'}</>}
          </div>
        </div>
      </div>

      <div className="actions">
        {ct && !ct.running && (
          <button className="btn btn-primary" disabled={!!busy} onClick={() => act('container', api.redis.startContainer, 'Container Redis iniciado')}>
            {busy === 'container' ? 'A arrancar…' : ct.exists ? `▶ Iniciar container ${ct.name}` : `▶ Criar e arrancar container ${ct.name}`}
          </button>
        )}
        <button className="btn" disabled={!!busy} onClick={() => { void refreshInfo(); void search('0') }}>⟳ Atualizar</button>
        <button className="btn" disabled={!connected} onClick={() => setShowNew((v) => !v)}>+ Nova chave</button>
        <span className="grow" />
        <button className="btn btn-danger" disabled={!connected || !!busy}
          onClick={() => { if (confirm(`Apagar TODAS as chaves da db ${info?.db}?`)) void act('flush', api.redis.flush, 'Base de dados limpa') }}>Flush DB</button>
      </div>

      {showNew && (
        <div className="actions">
          <input className="input mono" placeholder="chave" value={newKey.key} onChange={(e) => setNewKey({ ...newKey, key: e.target.value })} />
          <input className="input mono grow" placeholder="valor (string ou JSON)" value={newKey.value} onChange={(e) => setNewKey({ ...newKey, value: e.target.value })} />
          <input className="input" style={{ width: 110 }} type="number" placeholder="TTL (s)" value={newKey.ttl} onChange={(e) => setNewKey({ ...newKey, ttl: e.target.value })} />
          <button className="btn btn-primary" disabled={!newKey.key.trim() || !!busy}
            onClick={() => act('set', () => api.redis.set(newKey.key.trim(), newKey.value, Number(newKey.ttl) || undefined), `Chave ${newKey.key} guardada`).then(() => { setShowNew(false); setNewKey({ key: '', value: '', ttl: '' }) })}>Guardar</button>
        </div>
      )}

      <div className="tab-body">
        {!connected ? (
          <div className="empty">
            <p>Sem ligação ao Redis em {info?.host}:{info?.port}.</p>
            <p className="muted small">Arranca o container acima, ou ajusta host/porta/password em Definições → Redis.</p>
          </div>
        ) : (
          <div className="endpoints">
            <div className="ep-list">
              <div className="ep-list-head">
                <input className="input mono grow" placeholder="padrão (ex.: sessao:*)" value={pattern} onChange={(e) => setPattern(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search('0')} />
                <button className="btn btn-sm" disabled={!!busy} onClick={() => search('0')}>Procurar</button>
              </div>
              {keys.map((k) => (
                <button key={k.key} className={`ep-item${selected?.key === k.key ? ' selected' : ''}`} onClick={() => open(k.key)} title={`${k.type} · ${fmtTtl(k.ttl)}`}>
                  <span className={`method method-${TYPE_TONE[k.type] === 'blue' ? 'post' : TYPE_TONE[k.type] === 'green' ? 'get' : TYPE_TONE[k.type] === 'amber' ? 'put' : 'patch'}`}>{k.type}</span>
                  <span className="ep-path mono">{k.key}</span>
                  {k.ttl > 0 && <span className="muted small" style={{ marginLeft: 'auto' }}>⏱</span>}
                </button>
              ))}
              {!keys.length && <div className="muted pad small">Nenhuma chave para "{pattern}".</div>}
              {cursor !== '0' && <button className="btn btn-sm" style={{ margin: 8 }} disabled={!!busy} onClick={() => search(cursor)}>Mais…</button>}
              <div className="muted pad small">{keys.length} chave(s) mostradas · SCAN{cursor !== '0' ? ' (há mais)' : ''}</div>
            </div>

            <div className="ep-main">
              {!selected && <div className="empty">Seleciona uma chave para ver o valor.</div>}
              {selected && (
                <>
                  <div className="row" style={{ flexWrap: 'wrap' }}>
                    <span className="mono" style={{ fontSize: 15 }}>{selected.key}</span>
                    <Badge tone={TYPE_TONE[selected.type] ?? 'muted'}>{selected.type}</Badge>
                    {selected.length !== undefined && <span className="muted small">{selected.length} elemento(s)</span>}
                    {selected.memory !== undefined && <span className="muted small">{selected.memory} bytes</span>}
                    <span className="grow" />
                    <button className="btn btn-sm" onClick={() => open(selected.key)}>⟳</button>
                    <button className="btn btn-sm btn-danger" disabled={!!busy}
                      onClick={() => { if (confirm(`Apagar a chave ${selected.key}?`)) void act('del', () => api.redis.del([selected.key]), 'Chave apagada').then(() => setSelected(null)) }}>Apagar</button>
                  </div>
                  <div className="row">
                    <span className="muted small">TTL: {fmtTtl(selected.ttl)}</span>
                    <input className="input" style={{ width: 120 }} type="number" placeholder="novo TTL (s)" value={ttlEdit} onChange={(e) => setTtlEdit(e.target.value)} />
                    <button className="btn btn-sm" disabled={!!busy} onClick={() => act('ttl', () => api.redis.expire(selected.key, Number(ttlEdit) || 0), Number(ttlEdit) > 0 ? 'TTL definido' : 'Expiração removida', false).then(() => open(selected.key))}>
                      {Number(ttlEdit) > 0 ? 'Definir TTL' : 'Remover expiração'}
                    </button>
                  </div>
                  {selected.type === 'string' ? (
                    <StringEditor kv={selected} busy={!!busy} onSave={(v) => act('set', () => api.redis.set(selected.key, v), 'Valor guardado', false).then(() => open(selected.key))} />
                  ) : (
                    <pre className="resp-body">{pretty(selected.value)}</pre>
                  )}
                </>
              )}

              <section>
                <h3>Consola</h3>
                <div className="row">
                  <input className="input mono grow" placeholder="ex.: HGETALL exemplo:cliente:1 · KEYS sessao:* · INFO memory" value={cmd} onChange={(e) => setCmd(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runCmd()} />
                  <button className="btn btn-sm btn-primary" disabled={!!busy || !cmd.trim()} onClick={runCmd}>Executar</button>
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
  const [text, setText] = useState(typeof kv.value === 'string' ? kv.value : '')
  useEffect(() => setText(typeof kv.value === 'string' ? kv.value : ''), [kv])
  const dirty = text !== kv.value
  return (
    <div>
      <textarea className="input mono" rows={Math.min(16, Math.max(4, text.split('\n').length + 1))} style={{ width: '100%' }} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row">
        <span className="muted small">{pretty(text) !== text ? 'JSON válido' : ''}</span>
        <span className="grow" />
        <button className="btn btn-sm" disabled={!dirty} onClick={() => setText(String(kv.value))}>Repor</button>
        <button className="btn btn-sm btn-primary" disabled={!dirty || busy} onClick={() => onSave(text)}>Guardar valor</button>
      </div>
    </div>
  )
}
