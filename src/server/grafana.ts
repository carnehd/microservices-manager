import type { GrafanaLogLine, GrafanaSettings, GrafanaTestResult } from '../shared/types'

/** Junta a config guardada com um override opcional vindo do pedido (para testar valores por gravar). */
export function mergeGrafana(base: GrafanaSettings, over?: Partial<GrafanaSettings>): GrafanaSettings {
  return { ...base, ...(over ?? {}) }
}

function baseUrl(cfg: GrafanaSettings): string {
  const u = (cfg.url ?? '').trim().replace(/\/+$/, '')
  if (!u) throw new Error('Grafana URL is missing')
  return u
}

function headers(cfg: GrafanaSettings): Record<string, string> {
  if (!cfg.token) throw new Error('Grafana token is missing')
  const h: Record<string, string> = { Authorization: `Bearer ${cfg.token.trim()}`, Accept: 'application/json' }
  if (cfg.orgId) h['X-Grafana-Org-Id'] = String(cfg.orgId)
  return h
}

async function fetchJson(url: string, cfg: GrafanaSettings): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, { headers: headers(cfg) })
  } catch (e) {
    throw new Error(`could not reach Grafana (${baseUrl(cfg)}): ${e instanceof Error ? e.message : String(e)}`)
  }
  const text = await res.text()
  if (!res.ok) {
    const detail = text ? ` — ${text.slice(0, 200)}` : ''
    if (res.status === 401 || res.status === 403) throw new Error(`authentication rejected by Grafana (${res.status}); check the token${detail}`)
    if (res.status === 404) throw new Error(`resource not found in Grafana (404); check the datasource uid${detail}`)
    throw new Error(`Grafana responded ${res.status}${detail}`)
  }
  try {
    return text ? JSON.parse(text) : null
  } catch {
    throw new Error('Grafana response is not JSON (does the URL really point to a Grafana?)')
  }
}

/** Confirma URL + token + datasource. */
export async function grafanaTest(cfg: GrafanaSettings): Promise<GrafanaTestResult> {
  if (!cfg.datasourceUid) throw new Error('datasource uid is missing')
  const ds = (await fetchJson(`${baseUrl(cfg)}/api/datasources/uid/${encodeURIComponent(cfg.datasourceUid)}`, cfg)) as { name?: string; type?: string }
  return { ok: true, datasourceName: ds?.name, datasourceType: ds?.type }
}

const LEVEL_RE = /\b(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b/

function levelOf(labels: Record<string, string>, line: string): string | undefined {
  const l = labels.level ?? labels.detected_level ?? labels.severity
  if (l) return l.toUpperCase()
  const m = LEVEL_RE.exec(line)
  return m ? m[1].toUpperCase() : undefined
}

/** Consulta logs (LogQL) através do proxy do datasource do Grafana → Loki query_range. */
export async function grafanaLogs(
  cfg: GrafanaSettings,
  opts: { query?: string; limit?: number; sinceMinutes?: number }
): Promise<GrafanaLogLine[]> {
  if (!cfg.datasourceUid) throw new Error('datasource uid is missing')
  const query = (opts.query ?? cfg.query ?? '').trim()
  if (!query) throw new Error('query (LogQL) is missing')
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 5000)
  const sinceMs = Math.max(opts.sinceMinutes ?? 60, 1) * 60_000
  const endNs = `${Date.now()}000000`
  const startNs = `${Date.now() - sinceMs}000000`

  const qs = new URLSearchParams({ query, start: startNs, end: endNs, limit: String(limit), direction: 'backward' })
  const url = `${baseUrl(cfg)}/api/datasources/proxy/uid/${encodeURIComponent(cfg.datasourceUid)}/loki/api/v1/query_range?${qs}`
  const data = (await fetchJson(url, cfg)) as { data?: { result?: Array<{ stream?: Record<string, string>; values?: [string, string][] }> } }

  const out: GrafanaLogLine[] = []
  for (const stream of data?.data?.result ?? []) {
    const labels = stream.stream ?? {}
    for (const [tsNano, line] of stream.values ?? []) {
      out.push({ tsNano, ts: new Date(Number(tsNano.slice(0, 13))).toISOString(), line, labels, level: levelOf(labels, line) })
    }
  }
  out.sort((a, b) => (a.tsNano < b.tsNano ? 1 : a.tsNano > b.tsNano ? -1 : 0)) // mais recentes primeiro
  return out.slice(0, limit)
}
