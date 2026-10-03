import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, DbInfo } from '../../../shared/types'
import { api } from '../api'
import { Badge } from './common'

type Notify = (t: string, k?: 'error' | 'info' | 'success') => void

export function DatabaseView({
  settings, onSaveSettings, notify, fail
}: { settings: AppSettings; onSaveSettings: (p: Partial<AppSettings>) => Promise<AppSettings | null>; notify: Notify; fail: (e: unknown) => void }) {
  const [info, setInfo] = useState<DbInfo | null>(null)
  const [dbs, setDbs] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [form, setForm] = useState({ db: '', user: '', password: '', createUser: true })
  const [sqlDb, setSqlDb] = useState('')
  const [sql, setSql] = useState('')
  const [out, setOut] = useState<{ output: string; error: boolean } | null>(null)
  const pg = settings.postgres

  const refresh = useCallback(async () => {
    try {
      const i = await api.db.info()
      setInfo(i)
      if (i.ready) {
        const list = await api.db.databases()
        setDbs(list)
        setSqlDb((cur) => cur || list.find((d) => d === pg.superUser) || list[0] || '')
      }
    } catch (e) {
      fail(e)
    }
  }, [fail, pg.superUser])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const act = async (label: string, fn: () => Promise<unknown>, done?: string): Promise<void> => {
    setBusy(label)
    try {
      const r = await fn()
      if (done) notify(done, 'success')
      else if (Array.isArray(r)) notify(r.join(' · ') || 'done', 'success')
      await refresh()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const runSql = async (): Promise<void> => {
    setBusy('sql')
    try {
      const r = await api.db.sql(sqlDb, sql)
      setOut(r)
      const list = await api.db.databases()
      setDbs(list)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const ct = info?.container
  const ready = !!info?.ready

  return (
    <main className="service">
      <div className="svc-header">
        <div className="grow">
          <h2>Database <Badge tone={ready ? 'green' : 'red'}>{ready ? 'ready' : ct?.running ? 'starting' : 'no connection'}</Badge></h2>
          <div className="muted small">
            {info ? <>container <b>{ct?.name}</b> ({pg.superUser}@…:{pg.port}) · {ct?.running ? 'running' : ct?.exists ? 'stopped' : 'does not exist'}{ready ? ` · ${dbs.length} databases` : ''}</> : 'connecting…'}
            {info?.engineError && <span className="text-error"> · {info.engineError}</span>}
          </div>
        </div>
      </div>

      <div className="actions">
        {!ct?.running && <button className="btn btn-primary" disabled={!!busy} onClick={() => act('start', api.db.start, 'Postgres started')}>{busy === 'start' ? 'Starting…' : ct?.exists ? '▶ Start container' : '▶ Create and start Postgres'}</button>}
        <button className="btn" disabled={!!busy} onClick={refresh}>⟳ Refresh</button>
      </div>
      {info && info.candidates.length > 0 && (
        <div className="actions">
          <span className="muted small">Postgres containers found:</span>
          {info.candidates.map((c) => (
            <span key={c.name} className="row" style={{ gap: 6 }}>
              <span className="mono small">{c.name} <span className="muted">({c.image}{c.running ? '' : ', stopped'})</span></span>
              {c.name !== pg.containerName && <button className="btn btn-sm" disabled={!!busy} onClick={() => onSaveSettings({ postgres: { ...pg, containerName: c.name } }).then(() => refresh())} title="Use this existing container">Use this</button>}
            </span>
          ))}
        </div>
      )}

      <div className="tab-body">
        {!ready ? (
          <div className="empty">
            <p>No connection to Postgres.</p>
            <p className="muted small">Start the container above, or in Settings → Database enter the name of an existing container, the superuser and the password.</p>
          </div>
        ) : (
          <div className="config">
            <section>
              <h3>New database</h3>
              <div className="form">
                <div className="form-row">
                  <label>Database name *<input className="input mono" value={form.db} onChange={(e) => setForm({ ...form, db: e.target.value })} placeholder="e.g. order_db" /></label>
                  <label>User (owner)<input className="input mono" value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} placeholder={pg.superUser} /></label>
                  <label>Password<input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
                  <label className="check" style={{ alignSelf: 'end', paddingBottom: 6 }}><input type="checkbox" checked={form.createUser} onChange={(e) => setForm({ ...form, createUser: e.target.checked })} /> create user</label>
                  <button className="btn btn-primary" style={{ alignSelf: 'end' }} disabled={!!busy || !form.db.trim()}
                    onClick={() => act('create', () => api.db.createManual({ db: form.db.trim(), user: form.user.trim() || undefined, password: form.password || undefined, createUser: form.createUser })).then(() => setForm({ db: '', user: '', password: '', createUser: true }))}>Create database</button>
                </div>
                <p className="muted small">Creates the database (and the user/owner, if checked) in the container. To create tables, use the SQL console below.</p>
              </div>
            </section>

            <section>
              <div className="row">
                <h3 className="grow">Databases ({dbs.length})</h3>
              </div>
              <div className="chips-list">{dbs.map((d) => <button key={d} className={`chip${d === sqlDb ? ' chip-sel' : ''}`} onClick={() => setSqlDb(d)} title="use in the SQL console">{d}</button>)}</div>
            </section>

            <section>
              <div className="row">
                <h3 className="grow">SQL console</h3>
                <label className="inline">Database
                  <select className="input" value={sqlDb} onChange={(e) => { setSqlDb(e.target.value); setOut(null) }}>
                    {dbs.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </label>
              </div>
              <textarea className="input mono" rows={7} value={sql} onChange={(e) => setSql(e.target.value)} placeholder={'CREATE TABLE cliente (\n  id serial PRIMARY KEY,\n  nome text NOT NULL\n);\nINSERT INTO cliente (nome) VALUES (\'Ana\');\nSELECT * FROM cliente;'} />
              <div className="row">
                <span className="muted small">Run as {pg.superUser} on database {sqlDb}</span>
                <span className="grow" />
                <button className="btn btn-primary" disabled={!!busy || !sql.trim() || !sqlDb} onClick={runSql}>{busy === 'sql' ? 'Running…' : 'Run SQL'}</button>
              </div>
              {out && <pre className={`resp-body${out.error ? ' sql-error' : ''}`}>{out.output}</pre>}
            </section>
          </div>
        )}
      </div>
    </main>
  )
}
