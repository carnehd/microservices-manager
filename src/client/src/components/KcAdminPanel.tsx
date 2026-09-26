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
        <p>Liga-te à Admin REST API com as credenciais definidas nas Definições.</p>
        {!running && <p className="muted small">O Keycloak não foi arrancado por esta app — se estiver a correr noutro lado na porta configurada, a ligação funciona na mesma.</p>}
        <button className="btn btn-primary" disabled={busy} onClick={connect}>{busy ? 'A ligar…' : 'Ligar'}</button>
      </div>
    )
  }

  const createUser = (): Promise<void> => guard(async () => {
    if (!newUser.username.trim()) throw new Error('Username obrigatório')
    await api.kcAdmin.createUser(realm, newUser)
    setNewUser(EMPTY_USER)
    notify(`Utilizador ${newUser.username} criado`, 'success')
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
            {realms.map((r) => <option key={r.id} value={r.realm}>{r.realm}{r.enabled ? '' : ' (desativado)'}</option>)}
          </select>
        </label>
        <div className="tabs inline">
          <button className={tab === 'realms' ? 'active' : ''} onClick={() => setTab('realms')}>Realms</button>
          <button className={tab === 'clients' ? 'active' : ''} onClick={() => setTab('clients')}>Clients</button>
          <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>Utilizadores</button>
          <button className={tab === 'providers' ? 'active' : ''} onClick={() => setTab('providers')}>Providers carregados</button>
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
              <input className="input grow" placeholder="procurar…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && loadUsers()} />
              <button className="btn btn-sm" disabled={busy} onClick={loadUsers}>Procurar</button>
            </div>
            <table className="grid">
              <thead><tr><th>Username</th><th>Email</th><th>Nome</th><th>Ativo</th><th></th></tr></thead>
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
                          <input className="input" type="password" placeholder="nova password" value={pwFor.value} autoFocus
                            onChange={(e) => setPwFor({ id: u.id, value: e.target.value })}
                            onKeyDown={(e) => { if (e.key === 'Escape') setPwFor(null) }} />
                          <button className="btn btn-sm btn-primary" disabled={busy || !pwFor.value}
                            onClick={() => guard(async () => { await api.kcAdmin.resetPassword(realm, u.id, pwFor.value); setPwFor(null); notify('Password alterada', 'success') })}>OK</button>
                          <button className="btn btn-sm" onClick={() => setPwFor(null)}>✕</button>
                        </>
                      ) : (
                        <>
                          <button className="btn btn-sm" disabled={busy} onClick={() => setPwFor({ id: u.id, value: '' })}>Password</button>
                          <button className="btn btn-sm btn-danger" disabled={busy}
                            onClick={() => { if (confirm(`Apagar o utilizador ${u.username}?`)) void guard(async () => { await api.kcAdmin.deleteUser(realm, u.id); setUsers(await api.kcAdmin.users(realm, search)) }) }}>Apagar</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                {!users.length && <tr><td colSpan={5} className="muted">Sem utilizadores.</td></tr>}
              </tbody>
            </table>
          </section>
          <section>
            <h3>Novo utilizador</h3>
            <div className="form form-row">
              <input className="input" placeholder="username *" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} />
              <input className="input" placeholder="email" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} />
              <input className="input" placeholder="nome" value={newUser.firstName} onChange={(e) => setNewUser({ ...newUser, firstName: e.target.value })} />
              <input className="input" placeholder="apelido" value={newUser.lastName} onChange={(e) => setNewUser({ ...newUser, lastName: e.target.value })} />
              <input className="input" type="password" placeholder="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} />
              <button className="btn btn-primary" disabled={busy} onClick={createUser}>Criar</button>
            </div>
          </section>
        </div>
      )}

      {tab === 'providers' && (
        <div className="config">
          <section>
            <p className="muted small">Lista de <span className="mono">/admin/serverinfo</span> — confirma aqui se o teu SPI foi carregado (filtra pelo id do provider).</p>
            <div className="row">
              <input className="input grow" placeholder="filtrar por SPI ou provider id…" value={provFilter} onChange={(e) => setProvFilter(e.target.value)} />
              <button className="btn btn-sm" disabled={busy} onClick={loadProviders}>⟳</button>
            </div>
            <table className="grid">
              <thead><tr><th>SPI</th><th>Providers</th></tr></thead>
              <tbody>
                {shownProviders.map((p) => (
                  <tr key={p.spi}><td className="mono">{p.spi}</td><td className="mono small">{p.providers.join(', ')}</td></tr>
                ))}
                {!shownProviders.length && <tr><td colSpan={2} className="muted">Nada a mostrar.</td></tr>}
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
    if (!realm) throw new Error('Nome do realm obrigatório')
    const src = source.startsWith('realm:')
      ? ({ kind: 'realm', name: source.slice(6) } as const)
      : source.startsWith('file:')
        ? ({ kind: 'file', name: source.slice(5) } as const)
        : undefined
    await api.kcAdmin.createRealm({ realm, displayName: displayName.trim() || undefined, source: src })
    notify(src ? `Realm ${realm} criado a partir de ${src.name}` : `Realm ${realm} criado`, 'success')
    setName('')
    setDisplayName('')
    await onChanged(realm)
  })

  /** Cria vários realms de uma vez a partir da mesma origem: "local, dev, sit" */
  const createMany = (): Promise<void> => guard(async () => {
    const names = name.split(/[,\s]+/).map((n) => n.trim()).filter(Boolean)
    if (names.length < 2) throw new Error('Indica vários nomes separados por vírgula (ex.: local, dev, sit)')
    const src = source.startsWith('realm:') ? ({ kind: 'realm', name: source.slice(6) } as const) : source.startsWith('file:') ? ({ kind: 'file', name: source.slice(5) } as const) : undefined
    for (const realm of names) await api.kcAdmin.createRealm({ realm, displayName: displayName.trim() ? `${displayName.trim()} ${realm}` : undefined, source: src })
    notify(`Realms criados: ${names.join(', ')}`, 'success')
    setName('')
    await onChanged(names[names.length - 1])
  })

  const isMulti = /[,\s]/.test(name.trim())

  return (
    <div className="config">
      <section>
        <h3>Realms neste Keycloak</h3>
        <table className="grid">
          <thead><tr><th>Realm</th><th>Nome a mostrar</th><th>Ativo</th><th>Registo</th><th></th></tr></thead>
          <tbody>
            {realms.map((r) => (
              <tr key={r.id}>
                <td className="mono"><a className="link" onClick={() => onOpen(r.realm)}>{r.realm}</a></td>
                <td>{r.displayName ?? ''}</td>
                <td>{r.enabled ? '✓' : '✗'}</td>
                <td>
                  <input type="checkbox" checked={!!r.registrationAllowed} disabled={busy || r.realm === 'master'} title="Mostra o link Register na página de login do Keycloak"
                    onChange={(e) => guard(async () => { await api.kcAdmin.updateRealm(r.realm, { registrationAllowed: e.target.checked }); await onChanged(); })} />
                </td>
                <td className="cell-actions">
                  <button className="btn btn-sm" disabled={busy} title="Exporta clients, roles e grupos (sem utilizadores) para keycloak-realms/ na pasta raiz"
                    onClick={() => guard(async () => { const { file } = await api.kcAdmin.exportRealm(r.realm); notify(`Exportado para ${file}`, 'success'); await loadFiles() })}>Exportar JSON</button>
                  {r.realm !== 'master' && (
                    <button className="btn btn-sm btn-danger" disabled={busy}
                      onClick={() => { if (confirm(`Apagar o realm ${r.realm} e tudo o que contém (clients, utilizadores…)?`)) void guard(async () => { await api.kcAdmin.deleteRealm(r.realm); notify(`Realm ${r.realm} apagado`, 'info'); await onChanged() }) }}>Apagar</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h3>Novo realm</h3>
        <div className="form">
          <div className="form-row">
            <label>
              Nome (ou vários: local, dev, sit)
              <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="exemplo-dev" onKeyDown={(e) => e.key === 'Enter' && (isMulti ? createMany() : create())} />
            </label>
            <label>
              Nome a mostrar
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Exemplo" />
            </label>
            <label>
              Configuração inicial
              <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">Vazio</option>
                <optgroup label="Copiar de um realm existente">
                  {realms.map((r) => <option key={r.id} value={`realm:${r.realm}`}>{r.realm}</option>)}
                </optgroup>
                {files.length > 0 && (
                  <optgroup label="Importar de keycloak-realms/">
                    {files.map((f) => <option key={f} value={`file:${f}`}>{f}</option>)}
                  </optgroup>
                )}
              </select>
            </label>
            <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={isMulti ? createMany : create}>
              {busy ? 'A criar…' : isMulti ? 'Criar todos' : 'Criar'}
            </button>
          </div>
          <p className="muted small">
            "Copiar de" duplica clients, roles, grupos, scopes e fluxos (não os utilizadores; os segredos dos clients confidenciais são regenerados).
            As exportações ficam em <span className="mono">keycloak-realms/</span> na pasta raiz — versiona-as para recriar os realms noutra máquina.
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
    if (!c.clientId.trim()) throw new Error('Client ID obrigatório')
    await api.kcAdmin.createClient(realm, { clientId: c.clientId.trim(), name: c.name, publicClient: c.publicClient, directAccessGrants: c.directAccessGrants, redirectUris: split(c.redirect), webOrigins: split(c.origins) })
    notify(`Client ${c.clientId} criado em ${realm}`, 'success')
    setC({ ...c, clientId: '', name: '' })
    await reload()
  })

  const shown = clients.filter((x) => showBuiltin || !BUILTIN_CLIENTS.has(x.clientId))
  return (
    <div className="config">
      <section>
        <div className="row">
          <h3 className="grow">Clients de <span className="mono">{realm}</span></h3>
          <label className="check"><input type="checkbox" checked={showBuiltin} onChange={(e) => setShowBuiltin(e.target.checked)} /> mostrar os internos do Keycloak</label>
        </div>
        <table className="grid">
          <thead><tr><th>Client ID</th><th>Protocolo</th><th>Tipo</th><th>Root URL</th><th>Ativo</th><th></th></tr></thead>
          <tbody>
            {shown.map((x) => (
              <tr key={x.id}>
                <td className="mono">{x.clientId}</td>
                <td>{x.protocol ?? ''}</td>
                <td>{x.publicClient ? 'público' : 'confidencial'}</td>
                <td className="mono small">{x.rootUrl ?? ''}</td>
                <td>{x.enabled ? '✓' : '✗'}</td>
                <td className="cell-actions">
                  {!BUILTIN_CLIENTS.has(x.clientId) && (
                    <button className="btn btn-sm btn-danger" disabled={busy}
                      onClick={() => { if (confirm(`Apagar o client ${x.clientId}?`)) void guard(async () => { await api.kcAdmin.deleteClient(realm, x.id); await reload() }) }}>Apagar</button>
                  )}
                </td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={6} className="muted">Sem clients.</td></tr>}
          </tbody>
        </table>
      </section>
      <section>
        <h3>Novo client</h3>
        <div className="form">
          <div className="form-row">
            <label>Client ID *<input className="input mono" value={c.clientId} onChange={(e) => setC({ ...c, clientId: e.target.value })} placeholder="exemplo-app" /></label>
            <label>Nome<input className="input" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></label>
            <label>Tipo
              <select className="input" value={c.publicClient ? 'public' : 'conf'} onChange={(e) => setC({ ...c, publicClient: e.target.value === 'public' })}>
                <option value="public">público (SPA / testes)</option>
                <option value="conf">confidencial (com secret)</option>
              </select>
            </label>
            <label>Redirect URIs<input className="input mono" value={c.redirect} onChange={(e) => setC({ ...c, redirect: e.target.value })} placeholder="http://localhost:3000/*" /></label>
            <label>Web origins<input className="input mono" value={c.origins} onChange={(e) => setC({ ...c, origins: e.target.value })} /></label>
          </div>
          <div className="row">
            <label className="check"><input type="checkbox" checked={c.directAccessGrants} onChange={(e) => setC({ ...c, directAccessGrants: e.target.checked })} /> Direct access grants (necessário para obter tokens com utilizador/password no separador Endpoints)</label>
            <span className="grow" />
            <button className="btn btn-primary" disabled={busy || !c.clientId.trim()} onClick={create}>Criar client</button>
          </div>
        </div>
      </section>
    </div>
  )
}
