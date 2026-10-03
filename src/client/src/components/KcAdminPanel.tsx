import { useCallback, useEffect, useState } from 'react'
import type { KcClient, KcNewClient, KcNewUser, KcProviderInfo, KcRealm, KcUser } from '../../../shared/types'
import { api } from '../api'

type Tab = 'realms' | 'clients' | 'users' | 'providers'
type Notify = (t: string, k?: 'error' | 'info' | 'success') => void
const EMPTY_USER: KcNewUser = { username: '', email: '', firstName: '', lastName: '', password: '' }
const BUILTIN_CLIENTS = new Set(['account', 'account-console', 'admin-cli', 'broker', 'realm-management', 'security-admin-console'])

export function KcAdminPanel({ running, fail, notify }: { running: boolean; fail: (e: unknown) => void; notify: Notify }) {
  const [realms, setRealms] = useState<KcRealm[] | null>(null)
  const [realm, setRealm] = useState('')
  const [tab, setTab] = useState<Tab>('realms')
  const [users, setUsers] = useState<KcUser[]>([])
  const [clients, setClients] = useState<KcClient[]>([])
  const [providers, setProviders] = useState<KcProviderInfo[]>([])
  const [search, setSearch] = useState('')
  const [provFilter, setProvFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [newUser, setNewUser] = useState<KcNewUser>(EMPTY_USER)
  const [pwFor, setPwFor] = useState<{ id: string; value: string } | null>(null)

  const guard = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }, [fail])

  const loadRealms = useCallback(async (select?: string) => {
    const r = await api.kcAdmin.realms()
    setRealms(r)
    setRealm((cur) => select ?? (cur && r.some((x) => x.realm === cur) ? cur : r.find((x) => x.realm !== 'master')?.realm || r[0]?.realm || ''))
  }, [])
  const connect = useCallback(() => guard(() => loadRealms()), [guard, loadRealms])
  const loadUsers = useCallback(() => guard(async () => setUsers(await api.kcAdmin.users(realm, search))), [guard, realm, search])
  const loadClients = useCallback(() => guard(async () => setClients(await api.kcAdmin.clients(realm))), [guard, realm])
  const loadProviders = useCallback(() => guard(async () => setProviders(await api.kcAdmin.providers())), [guard])

  useEffect(() => {
    if (!realm) return
    if (tab === 'users') void loadUsers()
    else if (tab === 'clients') void loadClients()
    else if (tab === 'providers') void loadProviders()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realm, tab])

  if (!realms) {
    return (
      <div className="empty">
        <p>Connect to the Admin REST API with the credentials set in Settings.</p>
        {!running && <p className="muted small">Keycloak was not started by this app — if it is running elsewhere on the configured port, the connection still works.</p>}
        <button className="btn btn-primary" disabled={busy} onClick={connect}>{busy ? 'Connecting…' : 'Connect'}</button>
      </div>
    )
  }

  const createUser = (): Promise<void> => guard(async () => {
    if (!newUser.username.trim()) throw new Error('Username required')
    await api.kcAdmin.createUser(realm, newUser)
    setNewUser(EMPTY_USER)
    notify(`User ${newUser.username} created`, 'success')
    setUsers(await api.kcAdmin.users(realm, search))
  })

  const shownProviders = providers
    .map((p) => ({ spi: p.spi, providers: p.providers.filter((x) => !provFilter || x.toLowerCase().includes(provFilter.toLowerCase()) || p.spi.toLowerCase().includes(provFilter.toLowerCase())) }))
    .filter((p) => p.providers.length)

  return (
    <div className="admin">
      <div className="toolbar">
        <label className="inline">Realm
          <select className="input" value={realm} onChange={(e) => setRealm(e.target.value)}>
            {realms.map((r) => <option key={r.id} value={r.realm}>{r.realm}{r.enabled ? '' : ' (disabled)'}</option>)}
          </select>
        </label>
        <div className="tabs inline">
          <button className={tab === 'realms' ? 'active' : ''} onClick={() => setTab('realms')}>Realms</button>
          <button className={tab === 'clients' ? 'active' : ''} onClick={() => setTab('clients')}>Clients</button>
          <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>Users</button>
          <button className={tab === 'providers' ? 'active' : ''} onClick={() => setTab('providers')}>Loaded providers</button>
        </div>
        <span className="grow" />
        <button className="btn btn-sm" disabled={busy} onClick={connect}>⟳ Realms</button>
      </div>

      {tab === 'realms' && (
        <RealmsTab realms={realms} busy={busy} guard={guard} notify={notify} onChanged={(select) => loadRealms(select)} onOpen={(r) => { setRealm(r); setTab('clients') }} />
      )}

      {tab === 'clients' && (
        <ClientsTab realm={realm} clients={clients} busy={busy} guard={guard} notify={notify} reload={async () => setClients(await api.kcAdmin.clients(realm))} />
      )}

      {tab === 'users' && (
        <div className="config">
          <section>
            <div className="row">
              <input className="input grow" placeholder="search…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && loadUsers()} />
              <button className="btn btn-sm" disabled={busy} onClick={loadUsers}>Search</button>
            </div>
            <table className="grid">
              <thead><tr><th>Username</th><th>Email</th><th>Name</th><th>Enabled</th><th></th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="mono">{u.username}</td>
                    <td>{u.email ?? ''}</td>
                    <td>{[u.firstName, u.lastName].filter(Boolean).join(' ')}</td>
                    <td>
                      <input type="checkbox" checked={u.enabled} disabled={busy}
                        onChange={(e) => guard(async () => { await api.kcAdmin.setUserEnabled(realm, u.id, e.target.checked); setUsers(await api.kcAdmin.users(realm, search)) })} />
                    </td>
                    <td className="cell-actions">
                      {pwFor?.id === u.id ? (
                        <>
                          <input className="input" type="password" placeholder="new password" value={pwFor.value} autoFocus
                            onChange={(e) => setPwFor({ id: u.id, value: e.target.value })}
                            onKeyDown={(e) => { if (e.key === 'Escape') setPwFor(null) }} />
                          <button className="btn btn-sm btn-primary" disabled={busy || !pwFor.value}
                            onClick={() => guard(async () => { await api.kcAdmin.resetPassword(realm, u.id, pwFor.value); setPwFor(null); notify('Password changed', 'success') })}>OK</button>
                          <button className="btn btn-sm" onClick={() => setPwFor(null)}>✕</button>
                        </>
                      ) : (
                        <>
                          <button className="btn btn-sm" disabled={busy} onClick={() => setPwFor({ id: u.id, value: '' })}>Password</button>
                          <button className="btn btn-sm btn-danger" disabled={busy}
                            onClick={() => { if (confirm(`Delete the user ${u.username}?`)) void guard(async () => { await api.kcAdmin.deleteUser(realm, u.id); setUsers(await api.kcAdmin.users(realm, search)) }) }}>Delete</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                {!users.length && <tr><td colSpan={5} className="muted">No users.</td></tr>}
              </tbody>
            </table>
          </section>
          <section>
            <h3>New user</h3>
            <div className="form form-row">
              <input className="input" placeholder="username *" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} />
              <input className="input" placeholder="email" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} />
              <input className="input" placeholder="first name" value={newUser.firstName} onChange={(e) => setNewUser({ ...newUser, firstName: e.target.value })} />
              <input className="input" placeholder="last name" value={newUser.lastName} onChange={(e) => setNewUser({ ...newUser, lastName: e.target.value })} />
              <input className="input" type="password" placeholder="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} />
              <button className="btn btn-primary" disabled={busy} onClick={createUser}>Create</button>
            </div>
          </section>
        </div>
      )}

      {tab === 'providers' && (
        <div className="config">
          <section>
            <p className="muted small">List from <span className="mono">/admin/serverinfo</span> — check here whether your SPI was loaded (filter by the provider id).</p>
            <div className="row">
              <input className="input grow" placeholder="filter by SPI or provider id…" value={provFilter} onChange={(e) => setProvFilter(e.target.value)} />
              <button className="btn btn-sm" disabled={busy} onClick={loadProviders}>⟳</button>
            </div>
            <table className="grid">
              <thead><tr><th>SPI</th><th>Providers</th></tr></thead>
              <tbody>
                {shownProviders.map((p) => (
                  <tr key={p.spi}><td className="mono">{p.spi}</td><td className="mono small">{p.providers.join(', ')}</td></tr>
                ))}
                {!shownProviders.length && <tr><td colSpan={2} className="muted">Nothing to show.</td></tr>}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </div>
  )
}

function RealmsTab({
  realms, busy, guard, notify, onChanged, onOpen
}: {
  realms: KcRealm[]
  busy: boolean
  guard: (fn: () => Promise<void>) => Promise<void>
  notify: Notify
  onChanged: (select?: string) => Promise<void>
  onOpen: (realm: string) => void
}) {
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [source, setSource] = useState('') // '' | 'realm:<nome>' | 'file:<ficheiro>'
  const [files, setFiles] = useState<string[]>([])

  const loadFiles = useCallback(() => api.kcAdmin.realmFiles().then(setFiles).catch(() => setFiles([])), [])
  useEffect(() => {
    void loadFiles()
  }, [loadFiles])

  const create = (): Promise<void> => guard(async () => {
    const realm = name.trim()
    if (!realm) throw new Error('Realm name required')
    const src = source.startsWith('realm:')
      ? ({ kind: 'realm', name: source.slice(6) } as const)
      : source.startsWith('file:')
        ? ({ kind: 'file', name: source.slice(5) } as const)
        : undefined
    await api.kcAdmin.createRealm({ realm, displayName: displayName.trim() || undefined, source: src })
    notify(src ? `Realm ${realm} created from ${src.name}` : `Realm ${realm} created`, 'success')
    setName('')
    setDisplayName('')
    await onChanged(realm)
  })

  /** Cria vários realms de uma vez a partir da mesma origem: "local, dev, sit" */
  const createMany = (): Promise<void> => guard(async () => {
    const names = name.split(/[,\s]+/).map((n) => n.trim()).filter(Boolean)
    if (names.length < 2) throw new Error('Enter several names separated by commas (e.g. local, dev, sit)')
    const src = source.startsWith('realm:') ? ({ kind: 'realm', name: source.slice(6) } as const) : source.startsWith('file:') ? ({ kind: 'file', name: source.slice(5) } as const) : undefined
    for (const realm of names) await api.kcAdmin.createRealm({ realm, displayName: displayName.trim() ? `${displayName.trim()} ${realm}` : undefined, source: src })
    notify(`Realms created: ${names.join(', ')}`, 'success')
    setName('')
    await onChanged(names[names.length - 1])
  })

  const isMulti = /[,\s]/.test(name.trim())

  return (
    <div className="config">
      <section>
        <h3>Realms in this Keycloak</h3>
        <table className="grid">
          <thead><tr><th>Realm</th><th>Display name</th><th>Enabled</th><th>Registration</th><th></th></tr></thead>
          <tbody>
            {realms.map((r) => (
              <tr key={r.id}>
                <td className="mono"><a className="link" onClick={() => onOpen(r.realm)}>{r.realm}</a></td>
                <td>{r.displayName ?? ''}</td>
                <td>{r.enabled ? '✓' : '✗'}</td>
                <td>
                  <input type="checkbox" checked={!!r.registrationAllowed} disabled={busy || r.realm === 'master'} title="Shows the Register link on the Keycloak login page"
                    onChange={(e) => guard(async () => { await api.kcAdmin.updateRealm(r.realm, { registrationAllowed: e.target.checked }); await onChanged(); })} />
                </td>
                <td className="cell-actions">
                  <button className="btn btn-sm" disabled={busy} title="Exports clients, roles and groups (without users) to keycloak-realms/ in the root folder"
                    onClick={() => guard(async () => { const { file } = await api.kcAdmin.exportRealm(r.realm); notify(`Exported to ${file}`, 'success'); await loadFiles() })}>Export JSON</button>
                  {r.realm !== 'master' && (
                    <button className="btn btn-sm btn-danger" disabled={busy}
                      onClick={() => { if (confirm(`Delete the realm ${r.realm} and everything it contains (clients, users…)?`)) void guard(async () => { await api.kcAdmin.deleteRealm(r.realm); notify(`Realm ${r.realm} deleted`, 'info'); await onChanged() }) }}>Delete</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h3>New realm</h3>
        <div className="form">
          <div className="form-row">
            <label>
              Name (or several: local, dev, sit)
              <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="example-dev" onKeyDown={(e) => e.key === 'Enter' && (isMulti ? createMany() : create())} />
            </label>
            <label>
              Display name
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Example" />
            </label>
            <label>
              Initial configuration
              <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">Empty</option>
                <optgroup label="Copy from an existing realm">
                  {realms.map((r) => <option key={r.id} value={`realm:${r.realm}`}>{r.realm}</option>)}
                </optgroup>
                {files.length > 0 && (
                  <optgroup label="Import from keycloak-realms/">
                    {files.map((f) => <option key={f} value={`file:${f}`}>{f}</option>)}
                  </optgroup>
                )}
              </select>
            </label>
            <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={isMulti ? createMany : create}>
              {busy ? 'Creating…' : isMulti ? 'Create all' : 'Create'}
            </button>
          </div>
          <p className="muted small">
            "Copy from" duplicates clients, roles, groups, scopes and flows (not users; the secrets of confidential clients are regenerated).
            Exports go to <span className="mono">keycloak-realms/</span> in the root folder — version them to recreate the realms on another machine.
          </p>
        </div>
      </section>
    </div>
  )
}

function ClientsTab({
  realm, clients, busy, guard, notify, reload
}: {
  realm: string
  clients: KcClient[]
  busy: boolean
  guard: (fn: () => Promise<void>) => Promise<void>
  notify: Notify
  reload: () => Promise<void>
}) {
  const [c, setC] = useState<KcNewClient & { redirect: string; origins: string }>({ clientId: '', name: '', publicClient: true, directAccessGrants: true, redirectUris: [], webOrigins: [], redirect: '*', origins: '*' })
  const [showBuiltin, setShowBuiltin] = useState(false)
  const split = (s: string): string[] => s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean)

  const create = (): Promise<void> => guard(async () => {
    if (!c.clientId.trim()) throw new Error('Client ID required')
    await api.kcAdmin.createClient(realm, { clientId: c.clientId.trim(), name: c.name, publicClient: c.publicClient, directAccessGrants: c.directAccessGrants, redirectUris: split(c.redirect), webOrigins: split(c.origins) })
    notify(`Client ${c.clientId} created in ${realm}`, 'success')
    setC({ ...c, clientId: '', name: '' })
    await reload()
  })

  const shown = clients.filter((x) => showBuiltin || !BUILTIN_CLIENTS.has(x.clientId))
  return (
    <div className="config">
      <section>
        <div className="row">
          <h3 className="grow">Clients in <span className="mono">{realm}</span></h3>
          <label className="check"><input type="checkbox" checked={showBuiltin} onChange={(e) => setShowBuiltin(e.target.checked)} /> show Keycloak built-ins</label>
        </div>
        <table className="grid">
          <thead><tr><th>Client ID</th><th>Protocol</th><th>Type</th><th>Root URL</th><th>Enabled</th><th></th></tr></thead>
          <tbody>
            {shown.map((x) => (
              <tr key={x.id}>
                <td className="mono">{x.clientId}</td>
                <td>{x.protocol ?? ''}</td>
                <td>{x.publicClient ? 'public' : 'confidential'}</td>
                <td className="mono small">{x.rootUrl ?? ''}</td>
                <td>{x.enabled ? '✓' : '✗'}</td>
                <td className="cell-actions">
                  {!BUILTIN_CLIENTS.has(x.clientId) && (
                    <button className="btn btn-sm btn-danger" disabled={busy}
                      onClick={() => { if (confirm(`Delete the client ${x.clientId}?`)) void guard(async () => { await api.kcAdmin.deleteClient(realm, x.id); await reload() }) }}>Delete</button>
                  )}
                </td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={6} className="muted">No clients.</td></tr>}
          </tbody>
        </table>
      </section>
      <section>
        <h3>New client</h3>
        <div className="form">
          <div className="form-row">
            <label>Client ID *<input className="input mono" value={c.clientId} onChange={(e) => setC({ ...c, clientId: e.target.value })} placeholder="example-app" /></label>
            <label>Name<input className="input" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></label>
            <label>Type
              <select className="input" value={c.publicClient ? 'public' : 'conf'} onChange={(e) => setC({ ...c, publicClient: e.target.value === 'public' })}>
                <option value="public">public (SPA / testing)</option>
                <option value="conf">confidential (with secret)</option>
              </select>
            </label>
            <label>Redirect URIs<input className="input mono" value={c.redirect} onChange={(e) => setC({ ...c, redirect: e.target.value })} placeholder="http://localhost:3000/*" /></label>
            <label>Web origins<input className="input mono" value={c.origins} onChange={(e) => setC({ ...c, origins: e.target.value })} /></label>
          </div>
          <div className="row">
            <label className="check"><input type="checkbox" checked={c.directAccessGrants} onChange={(e) => setC({ ...c, directAccessGrants: e.target.checked })} /> Direct access grants (needed to obtain tokens with username/password in the Endpoints tab)</label>
            <span className="grow" />
            <button className="btn btn-primary" disabled={busy || !c.clientId.trim()} onClick={create}>Create client</button>
          </div>
        </div>
      </section>
    </div>
  )
}
