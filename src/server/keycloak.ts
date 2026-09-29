import type { KcClient, KcNewClient, KcNewUser, KcProviderInfo, KcRealm, KcRealmPatch, KcUser } from '../shared/types'

/** Cliente mínimo da Admin REST API (password grant no admin-cli do realm master). */
export class KcAdmin {
  private token?: { value: string; exp: number }

  constructor(
    private readonly baseUrl: string,
    private readonly user: string,
    private readonly pass: string
  ) {}

  private async login(): Promise<string> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'admin-cli',
          username: this.user,
          password: this.pass
        })
      })
    } catch (e) {
      throw new Error(`Keycloak não responde em ${this.baseUrl} (está a correr?)`)
    }
    if (!res.ok) throw new Error(`Login no Keycloak falhou (${res.status}): ${await res.text()}`)
    const j = (await res.json()) as { access_token: string; expires_in: number }
    this.token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 }
    return j.access_token
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.exp - 5000) return this.token.value
    return this.login()
  }

  private async req<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
    const token = await this.getToken()
    const res = await fetch(`${this.baseUrl}/admin${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    if (res.status === 401 && retry) {
      this.token = undefined // Keycloak reiniciou: token inválido
      return this.req<T>(method, path, body, false)
    }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`)
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  realms(): Promise<KcRealm[]> {
    return this.req('GET', '/realms')
  }

  createRealm(rep: Record<string, unknown>): Promise<void> {
    return this.req('POST', '/realms', rep)
  }

  /** PUT parcial: o Keycloak só altera os campos presentes. */
  updateRealm(realm: string, patch: KcRealmPatch): Promise<void> {
    return this.req('PUT', `/realms/${encodeURIComponent(realm)}`, patch)
  }

  deleteRealm(realm: string): Promise<void> {
    if (realm === 'master') throw new Error('O realm master não pode ser apagado')
    return this.req('DELETE', `/realms/${encodeURIComponent(realm)}`)
  }

  /** Exportação parcial (sem utilizadores; segredos mascarados) — a mesma da consola de administração. */
  exportRealm(realm: string): Promise<Record<string, unknown>> {
    return this.req('POST', `/realms/${encodeURIComponent(realm)}/partial-export?exportClients=true&exportGroupsAndRoles=true`)
  }

  clients(realm: string): Promise<KcClient[]> {
    return this.req('GET', `/realms/${encodeURIComponent(realm)}/clients?max=200`)
  }

  createClient(realm: string, c: KcNewClient): Promise<void> {
    return this.req('POST', `/realms/${encodeURIComponent(realm)}/clients`, {
      clientId: c.clientId,
      name: c.name || undefined,
      enabled: true,
      protocol: 'openid-connect',
      publicClient: c.publicClient,
      directAccessGrantsEnabled: c.directAccessGrants,
      standardFlowEnabled: true,
      redirectUris: c.redirectUris,
      webOrigins: c.webOrigins
    })
  }

  deleteClient(realm: string, id: string): Promise<void> {
    return this.req('DELETE', `/realms/${encodeURIComponent(realm)}/clients/${id}`)
  }

  users(realm: string, search = ''): Promise<KcUser[]> {
    return this.req('GET', `/realms/${encodeURIComponent(realm)}/users?max=100&search=${encodeURIComponent(search)}`)
  }

  createUser(realm: string, u: KcNewUser): Promise<void> {
    // O perfil de utilizador do Keycloak (≥ 24) exige email, nome e apelido; sem eles o login
    // falha com "Account is not fully set up". Para um ambiente local, preenche-se com valores razoáveis.
    return this.req('POST', `/realms/${encodeURIComponent(realm)}/users`, {
      username: u.username,
      email: u.email || `${u.username}@local.test`,
      firstName: u.firstName || u.username,
      lastName: u.lastName || 'Local',
      enabled: true,
      emailVerified: true,
      credentials: u.password ? [{ type: 'password', value: u.password, temporary: false }] : []
    })
  }

  setUserEnabled(realm: string, id: string, enabled: boolean): Promise<void> {
    return this.req('PUT', `/realms/${encodeURIComponent(realm)}/users/${id}`, { enabled })
  }

  resetPassword(realm: string, id: string, password: string): Promise<void> {
    return this.req('PUT', `/realms/${encodeURIComponent(realm)}/users/${id}/reset-password`, {
      type: 'password',
      value: password,
      temporary: false
    })
  }

  deleteUser(realm: string, id: string): Promise<void> {
    return this.req('DELETE', `/realms/${encodeURIComponent(realm)}/users/${id}`)
  }

  /** SPIs e providers carregados — útil para confirmar que um SPI custom foi apanhado pelo Keycloak. */
  async providers(): Promise<KcProviderInfo[]> {
    const info = await this.req<{ providers?: Record<string, { providers?: Record<string, unknown> }> }>('GET', '/serverinfo')
    return Object.entries(info.providers ?? {})
      .map(([spi, v]) => ({ spi, providers: Object.keys(v.providers ?? {}).sort() }))
      .sort((a, b) => a.spi.localeCompare(b.spi))
  }
}

const STRIP_KEYS = new Set(['id', 'containerId', 'internalId'])

function stripIds(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripIds)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (!STRIP_KEYS.has(k)) out[k] = stripIds(val)
    return out
  }
  return v
}

/**
 * Prepara uma exportação para ser importada com outro nome (ou noutro servidor):
 * remove ids (são chaves globais na BD — colidiriam com o realm de origem), as chaves de assinatura
 * (vêm mascaradas; o Keycloak gera novas) e os segredos mascarados dos clients.
 */
export function prepareRealmImport(exported: Record<string, unknown>, target: string, displayName?: string): Record<string, unknown> {
  const source = String(exported.realm ?? '')
  let json = JSON.stringify(exported)
  if (source && source !== target) json = json.split(`"default-roles-${source}"`).join(`"default-roles-${target}"`)
  const rep = stripIds(JSON.parse(json)) as Record<string, unknown>
  delete rep.components
  rep.realm = target
  rep.displayName = displayName ?? (source === target ? rep.displayName : target)
  rep.enabled = true
  for (const c of (rep.clients as Array<Record<string, unknown>> | undefined) ?? []) {
    if (c.secret === '**********') delete c.secret
    delete c.authenticationFlowBindingOverrides
  }
  return rep
}
