import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, ServiceInfo, SrDbStatus, SrTableData } from '../../../shared/types'
import { api } from '../api'

type Notify = (text: string, kind?: 'error' | 'info' | 'success') => void

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <div className="srdb-check">
      <span className={ok ? 'srdb-ok' : 'srdb-no'}>{ok ? '✓' : '○'}</span> {children}
    </div>
  )
}

function fmtCell(v: unknown): { text: string; empty: boolean } {
  if (v === null || v === undefined) return { text: '∅', empty: true }
  if (typeof v === 'object') return { text: JSON.stringify(v), empty: false }
  const text = String(v)
  return { text: text === '' ? '∅' : text, empty: text === '' }
}

export function SrDatabaseView({ svc, settings, running, notify, fail }: {
  svc: ServiceInfo; settings: AppSettings; running: boolean; notify: Notify; fail: (e: unknown) => void
}) {
  const [status, setStatus] = useState<SrDbStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const [tableData, setTableData] = useState<SrTableData | null>(null)
  const [tableBusy, setTableBusy] = useState(false)
  const [limit, setLimit] = useState(100)
  const [editing, setEditing] = useState(false)
  const [editDb, setEditDb] = useState('')
  const [editSchema, setEditSchema] = useState('')

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.srdb.status(svc.id))
    } catch (e) {
      fail(e)
    }
  }, [svc.id, fail])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Seleciona a 1ª tabela automaticamente quando a lista muda (mantém a seleção se ainda existir).
  const tablesKey = status?.tables.join('\u0000') ?? ''
  useEffect(() => {
    const tables = tablesKey ? tablesKey.split('\u0000') : []
    setSelectedTable((cur) => (cur && tables.includes(cur) ? cur : (tables[0] ?? null)))
  }, [tablesKey])

  // Carrega os dados da tabela selecionada (ou limpa quando não há nenhuma).
  useEffect(() => {
    if (!selectedTable) {
      setTableData(null)
      return
    }
    let cancelled = false
    setTableBusy(true)
    api.srdb.table(svc.id, selectedTable, limit)
      .then((d) => { if (!cancelled) setTableData(d) })
      .catch((e) => { if (!cancelled) { setTableData(null); fail(e) } })
      .finally(() => { if (!cancelled) setTableBusy(false) })
    return () => { cancelled = true }
  }, [svc.id, selectedTable, limit, fail])

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      notify('Copied', 'success')
    } catch {
      notify('Could not copy to the clipboard', 'error')
    }
  }

  const create = async (reset: boolean) => {
    if (reset && !window.confirm(`Drop and recreate the database "${svc.srDatabase?.database}"? All data will be lost.`)) return
    setBusy(reset ? 'reset' : 'create')
    try {
      const actions = await api.srdb.create(svc.id, reset)
      notify(actions.join(' · ') || 'Database created', 'success')
      if (reset) { setSelectedTable(null); setTableData(null) }
      await refresh()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  // Cria (ou arranca) o container do Postgres quando não existe/não está a correr.
  const startContainer = async () => {
    setBusy('container')
    try {
      const msg = await api.db.start()
      notify(msg || 'Postgres container ready', 'success')
      // o Postgres pode demorar a aceitar ligações: faz poll ao estado até ficar pronto
      let s = await api.srdb.status(svc.id)
      for (let i = 0; i < 16 && !s.postgresReady; i++) {
        await new Promise((r) => setTimeout(r, 500))
        s = await api.srdb.status(svc.id)
      }
      setStatus(s)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const drop = async () => {
    if (!window.confirm(`Drop the database "${svc.srDatabase?.database}"? All data will be permanently lost.`)) return
    setBusy('drop')
    try {
      const actions = await api.srdb.drop(svc.id)
      notify(actions.join(' · ') || 'Database dropped', 'success')
      setSelectedTable(null)
      setTableData(null)
      await refresh()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  if (!svc.srDatabase) return <div className="muted pad">No SR database detected for this service.</div>
  // valores em uso = os detetados + overrides guardados (vêm no status.spec)
  const sr = status?.spec ?? svc.srDatabase

  const startEdit = () => { setEditDb(sr.database); setEditSchema(sr.schema); setEditing(true) }
  const saveSpec = async () => {
    setBusy('spec')
    try {
      await api.srdb.saveSpec(svc.id, { database: editDb.trim(), schema: editSchema.trim() })
      notify('Database values updated', 'success')
      setEditing(false)
      await refresh()
    } catch (e) { fail(e) } finally { setBusy(null) }
  }
  const resetSpec = async () => {
    setBusy('spec')
    try {
      await api.srdb.saveSpec(svc.id, {}) // limpa override → volta ao detetado
      notify('Back to the detected values', 'success')
      setEditing(false)
      await refresh()
    } catch (e) { fail(e) } finally { setBusy(null) }
  }

  const pg = settings.postgres
  const host = 'localhost'
  const password = pg.superPassword ?? ''
  const jdbc = `jdbc:postgresql://${host}:${pg.port}/${sr.database}?currentSchema=${sr.schema}`

  const fields: Array<{ label: string; value: string; display?: React.ReactNode; extra?: React.ReactNode; editKey?: 'database' | 'schema' }> = [
    { label: 'Host', value: host },
    { label: 'Port', value: String(pg.port) },
    { label: 'Database', value: sr.database, editKey: 'database' },
    { label: 'Schema', value: sr.schema, editKey: 'schema' },
    { label: 'User', value: pg.superUser },
    {
      label: 'Password',
      value: password,
      display: password ? (showPassword ? password : '••••••••') : <span className="muted">(no password set)</span>,
      extra: password ? (
        <button className="btn btn-sm btn-ghost" onClick={() => setShowPassword((v) => !v)} title={showPassword ? 'Hide' : 'Show'}>
          {showPassword ? 'hide' : 'show'}
        </button>
      ) : undefined
    },
    { label: 'JDBC URL', value: jdbc }
  ]

  return (
    <div className="srdb-view">
      {/* ── Ligação (DBeaver) ───────────────────────────── */}
      <div className="srdb-card">
        <div className="row">
          <h3 style={{ margin: 0 }}>Detected values <span className="muted small">({sr.source})</span></h3>
          <span className="grow" />
          {!editing && <button className="btn btn-sm" onClick={startEdit} title="Edit the database/schema detected from the microservice">Edit</button>}
          {editing && <>
            <button className="btn btn-sm btn-primary" disabled={busy !== null || !editDb.trim() || !editSchema.trim()} onClick={() => void saveSpec()}>{busy === 'spec' ? 'Saving…' : 'Save'}</button>
            <button className="btn btn-sm" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn btn-sm btn-ghost" disabled={busy !== null} onClick={() => void resetSpec()} title="Back to the values detected from the microservice">Reset to detected</button>
          </>}
        </div>
        <div className="srdb-fields">
          {fields.map((f) => (
            <div className="srdb-field" key={f.label}>
              <span className="srdb-field-label">{f.label}</span>
              {editing && f.editKey ? (
                <input className="input mono grow" value={f.editKey === 'database' ? editDb : editSchema}
                  onChange={(e) => (f.editKey === 'database' ? setEditDb(e.target.value) : setEditSchema(e.target.value))} spellCheck={false} />
              ) : (
                <span className="srdb-field-value mono">{f.display ?? f.value}</span>
              )}
              {!editing && f.extra}
              {!editing && <button className="btn btn-sm" title={`Copy ${f.label}`} disabled={!f.value} onClick={() => void copy(f.value)}>copy</button>}
            </div>
          ))}
        </div>
        {editing && <p className="muted small">Override the values detected in the microservice (application.yaml / docker-compose). Used to create/check the database.</p>}
        {svc.srDatabase.detected && (
          <div className="srdb-detected">
            <div className="muted small">Read from the microservice to create the database:</div>
            {svc.srDatabase.detected.databaseFrom && <div className="small mono">• <b>database</b> ← {svc.srDatabase.detected.databaseFrom}</div>}
            {svc.srDatabase.detected.schemaFrom && <div className="small mono">• <b>schema</b> ← {svc.srDatabase.detected.schemaFrom}</div>}
            {svc.srDatabase.detected.liquibaseFrom && <div className="small mono">• <b>liquibase</b> ← {svc.srDatabase.detected.liquibaseFrom}</div>}
          </div>
        )}
      </div>

      {/* ── Estado + Ações ──────────────────────────────── */}
      <div className="srdb-card">
        <h3>Status</h3>
        {!status && <div className="muted">Checking…</div>}
        {status && (
          <>
            <Check ok={status.postgresReady}>Postgres reachable {status.container && <span className="muted">· container {status.container.name} {status.container.running ? 'running' : status.container.exists ? 'stopped' : 'does not exist'}</span>}</Check>
            <Check ok={status.databaseExists}>Database <span className="mono">{sr.database}</span> exists</Check>
            <Check ok={status.schemaExists}>Schema <span className="mono">{sr.schema}</span> exists</Check>
            <Check ok={status.tables.length > 0}>
              Tables created {status.tables.length > 0 ? <span className="muted">({status.tables.length})</span> : <span className="muted">(none yet — start the service for Liquibase to create them)</span>}
            </Check>
          </>
        )}
        <div className="srdb-actions">
          {status && !status.postgresReady && (
            <button className="btn btn-primary" disabled={busy !== null} onClick={() => void startContainer()}
              title={`${status.container?.exists ? 'Start' : 'Create and start'} the Postgres container "${status.container?.name}" (image/port/credentials from Settings)`}>
              {busy === 'container' ? 'Starting…' : status.container?.exists ? `▶ Start container ${status.container.name}` : `▶ Create container ${status.container?.name ?? ''}`}
            </button>
          )}
          <button className="btn btn-primary" disabled={busy !== null || !status?.postgresReady} onClick={() => create(false)}>
            {busy === 'create' ? 'Creating…' : 'Create database'}
          </button>
          <button className="btn btn-danger" disabled={busy !== null || !status?.databaseExists} title={running ? 'The service is running — active connections will be terminated (DROP … FORCE)' : 'Drops the database and all data'} onClick={() => void drop()}>
            {busy === 'drop' ? 'Dropping…' : 'Drop database'}
          </button>
          <button className="btn btn-danger" disabled={busy !== null || !status?.databaseExists} title={running ? 'Stop the service before resetting (there are active connections)' : 'Drops and recreates the database empty'} onClick={() => create(true)}>
            {busy === 'reset' ? 'Resetting…' : 'Reset (drop & recreate)'}
          </button>
          <button className="btn" disabled={busy !== null} onClick={() => void refresh()}>⟳ Check</button>
        </div>
        {!status?.postgresReady && status && (
          <p className="muted small">Postgres is not reachable. Make sure the container is running and that the Settings (container/port/superuser) point to it.</p>
        )}
        <p className="muted small">Flow: <b>Create database</b> → <b>Start</b> the service (Liquibase creates the tables) → view the data.</p>
      </div>

      {/* ── Tabelas (só leitura) ────────────────────────── */}
      <div className="srdb-card srdb-tables-card">
        <h3>Tables <span className="muted small">(read only)</span></h3>
        {status && status.tables.length === 0 && (
          <div className="muted small">No tables yet in schema <span className="mono">{sr.schema}</span> — start the service for Liquibase to create them.</div>
        )}
        {status && status.tables.length > 0 && (
          <>
            <div className="srdb-chips">
              {status.tables.map((t) => (
                <button key={t} className={`srdb-chip${t === selectedTable ? ' on' : ''}`} onClick={() => setSelectedTable(t)}>{t}</button>
              ))}
            </div>
            <div className="srdb-table-toolbar">
              <label className="muted small">Limit</label>
              <select className="srdb-limit" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                <option value={50}>50</option>
                <option value={100}>100</option>
                <option value={500}>500</option>
              </select>
              {tableData && <span className="muted small">{tableData.rows.length} {tableData.rows.length === 1 ? 'row' : 'rows'}</span>}
              {tableBusy && <span className="muted small">Loading…</span>}
            </div>
            {tableData?.truncated && (
              <p className="srdb-trunc small">Showing the first {tableData.limit} rows (there are more).</p>
            )}
            {tableData && (
              <div className="srdb-data-wrap">
                <table className="srdb-data">
                  <thead>
                    <tr>{tableData.columns.map((c) => <th key={c}>{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {tableData.rows.length === 0 && (
                      <tr><td className="srdb-data-empty muted" colSpan={Math.max(tableData.columns.length, 1)}>(empty table)</td></tr>
                    )}
                    {tableData.rows.map((row, i) => (
                      <tr key={i}>
                        {tableData.columns.map((c) => {
                          const { text, empty } = fmtCell(row[c])
                          return <td key={c} className={`mono${empty ? ' srdb-null' : ''}`}>{text}</td>
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
