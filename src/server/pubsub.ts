import type { PubSubInbox, PubSubInfo, PubSubMessage, PubSubSettings, PubSubStoredMessage, PubSubSubscription, PubSubTopic } from '../shared/types'
import { containerState, engineInfo, ensureContainer, traceCommands } from './containers'
import { logCmd } from './cmdlog'
import { getSettings } from './settings'

const NAME_RE = /^[A-Za-z][A-Za-z0-9_.~%+-]{2,254}$/ // nomes de tópico/subscrição do Pub/Sub

function cmd(): string {
  return getSettings().containerCommand?.trim() || 'podman'
}
function cfg(): PubSubSettings {
  return getSettings().pubsub
}
function baseUrl(p: PubSubSettings, project?: string): string {
  return `http://localhost:${p.port}/v1/projects/${encodeURIComponent((project || p.projectId).trim())}`
}

/** Estado do emulador (motor de containers, container, portas e endereços para os microserviços). */
export async function pubsubInfo(): Promise<PubSubInfo> {
  const p = cfg()
  const base: PubSubInfo = {
    engineOk: false,
    containerName: p.containerName,
    image: p.image,
    port: p.port,
    projectId: p.projectId,
    exists: false,
    running: false,
    emulatorHostLocal: `localhost:${p.port}`,
    emulatorHostContainer: `${p.containerName}:8085`
  }
  const { commands } = await traceCommands(async () => {
    try {
      const engine = await engineInfo(cmd())
      base.engineOk = engine.available
      if (!engine.available) {
        base.error = engine.error ?? 'container engine unavailable'
        return
      }
      const st = await containerState(cmd(), p.containerName)
      base.exists = st.exists
      base.running = st.running
    } catch (e) {
      base.error = e instanceof Error ? e.message : String(e)
    }
  })
  base.commands = commands
  return base
}

/** Arranca (ou cria) o container do emulador Pub/Sub. */
export async function startPubsub(): Promise<string> {
  const p = cfg()
  return ensureContainer(cmd(), {
    name: p.containerName,
    image: p.image,
    ports: [`${p.port}:8085`],
    args: ['gcloud', 'beta', 'emulators', 'pubsub', 'start', '--host-port=0.0.0.0:8085', `--project=${p.projectId}`]
  })
}

async function emu(path: string, init?: RequestInit, project?: string): Promise<unknown> {
  const p = cfg()
  const method = (init?.method ?? 'GET').toUpperCase()
  const proj = (project || p.projectId).trim()
  // Mostra a operação REST na consola comum (criar tópico/subscrição, publicar, etc.).
  logCmd(`${method} /v1/projects/${proj}${path}`, 'cmd')
  const t0 = Date.now()
  let res: Response
  try {
    res = await fetch(`${baseUrl(p, project)}${path}`, init)
  } catch (e) {
    logCmd(`emulator not responding at localhost:${p.port}`, 'err')
    throw new Error(`the emulator is not responding at localhost:${p.port} — start Pub/Sub first (${e instanceof Error ? e.message : String(e)})`)
  }
  const text = await res.text()
  if (!res.ok) {
    logCmd(`${res.status}${text ? ` — ${text.slice(0, 120)}` : ''}`, 'err')
    throw new Error(`Pub/Sub responded ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`)
  }
  logCmd(`${res.status} · ${Date.now() - t0} ms`, 'ok')
  return text ? JSON.parse(text) : null
}

function shortName(full: string): string {
  return full.split('/').pop() ?? full
}

export async function listTopics(project?: string): Promise<PubSubTopic[]> {
  const d = (await emu('/topics', undefined, project)) as { topics?: Array<{ name: string }> }
  return (d?.topics ?? []).map((t) => ({ name: shortName(t.name) }))
}

export async function createTopic(name: string, project?: string): Promise<PubSubTopic> {
  if (!NAME_RE.test(name)) throw new Error(`Invalid topic name: "${name}"`)
  const d = (await emu(`/topics/${encodeURIComponent(name)}`, { method: 'PUT' }, project)) as { name: string }
  return { name: shortName(d.name) }
}

export async function deleteTopic(name: string, project?: string): Promise<void> {
  if (!NAME_RE.test(name)) throw new Error(`Invalid topic name: "${name}"`)
  await emu(`/topics/${encodeURIComponent(name)}`, { method: 'DELETE' }, project)
}

/** Publica uma mensagem (de teste) num tópico; o payload é enviado em base64 para o emulador. */
export async function publishMessage(topic: string, data: string, attributes?: Record<string, string>, project?: string): Promise<{ messageId: string }> {
  if (!NAME_RE.test(topic)) throw new Error(`Invalid topic name: "${topic}"`)
  const message: { data: string; attributes?: Record<string, string> } = { data: Buffer.from(data, 'utf8').toString('base64') }
  if (attributes && Object.keys(attributes).length) message.attributes = attributes
  const d = (await emu(`/topics/${encodeURIComponent(topic)}:publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [message] })
  }, project)) as { messageIds?: string[] }
  return { messageId: d?.messageIds?.[0] ?? '' }
}

export async function listSubscriptions(project?: string): Promise<PubSubSubscription[]> {
  const d = (await emu('/subscriptions', undefined, project)) as { subscriptions?: Array<{ name: string; topic: string }> }
  return (d?.subscriptions ?? []).map((s) => ({ name: shortName(s.name), topic: shortName(s.topic) }))
}

export async function createSubscription(name: string, topic: string, project?: string): Promise<PubSubSubscription> {
  if (!NAME_RE.test(name)) throw new Error(`Invalid subscription name: "${name}"`)
  if (!NAME_RE.test(topic)) throw new Error(`Invalid topic name: "${topic}"`)
  const proj = (project || cfg().projectId).trim()
  const body = JSON.stringify({ topic: `projects/${proj}/topics/${topic}` })
  const d = (await emu(`/subscriptions/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body
  }, project)) as { name: string; topic: string }
  return { name: shortName(d.name), topic: shortName(d.topic) }
}

export async function deleteSubscription(name: string, project?: string): Promise<void> {
  if (!NAME_RE.test(name)) throw new Error(`Invalid subscription name: "${name}"`)
  await emu(`/subscriptions/${encodeURIComponent(name)}`, { method: 'DELETE' }, project)
}

// Histórico (inbox) por subscrição, em memória. A app faz pull+ack ao emulador e guarda aqui,
// para poderes ver SEMPRE todas as mensagens e o estado lida/não lida (perde-se se a app reiniciar).
const inbox = new Map<string, PubSubStoredMessage[]>()
const boxKey = (sub: string, project?: string): string => `${(project || cfg().projectId).trim()}\u0000${sub}`
function boxOf(sub: string, project?: string): PubSubStoredMessage[] {
  const key = boxKey(sub, project)
  let b = inbox.get(key)
  if (!b) {
    b = []
    inbox.set(key, b)
  }
  return b
}
function snapshot(sub: string, project?: string): PubSubInbox {
  const box = boxOf(sub, project)
  return { messages: [...box], unread: box.filter((m) => !m.read).length }
}

/** Vai buscar as mensagens novas do emulador (ack) e junta-as ao histórico como "não lidas". */
export async function pollInbox(subscription: string, max = 50, project?: string): Promise<PubSubInbox> {
  const fresh = await pullMessages(subscription, max, project)
  const box = boxOf(subscription, project)
  const seen = new Set(box.map((m) => m.id))
  const now = new Date().toISOString()
  for (const m of fresh) {
    const id = m.messageId || `${Date.now()}-${box.length}-${Math.random().toString(36).slice(2, 8)}`
    if (seen.has(id)) continue
    box.push({ ...m, id, read: false, receivedAt: now })
    seen.add(id)
  }
  return snapshot(subscription, project)
}

export function getInbox(subscription: string, project?: string): PubSubInbox {
  return snapshot(subscription, project)
}
export function markInboxRead(subscription: string, id?: string, project?: string): PubSubInbox {
  for (const m of boxOf(subscription, project)) if (!id || m.id === id) m.read = true
  return snapshot(subscription, project)
}
export function clearInbox(subscription: string, project?: string): PubSubInbox {
  inbox.set(boxKey(subscription, project), [])
  return snapshot(subscription, project)
}

/** Lê (pull) as mensagens de uma subscrição e confirma-as (ack), devolvendo o payload descodificado. */
export async function pullMessages(subscription: string, max = 20, project?: string): Promise<PubSubMessage[]> {
  if (!NAME_RE.test(subscription)) throw new Error(`Invalid subscription name: "${subscription}"`)
  const n = Math.min(Math.max(max, 1), 100)
  const sub = encodeURIComponent(subscription)
  const pull = (await emu(`/subscriptions/${sub}:pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxMessages: n, returnImmediately: true })
  }, project)) as { receivedMessages?: Array<{ ackId?: string; message?: { data?: string; attributes?: Record<string, string>; messageId?: string; publishTime?: string } }> }
  const received = pull?.receivedMessages ?? []
  const ackIds = received.map((r) => r.ackId).filter((a): a is string => !!a)
  if (ackIds.length) {
    await emu(`/subscriptions/${sub}:acknowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ackIds })
    }, project)
  }
  return received.map((r) => ({
    data: r.message?.data ? Buffer.from(r.message.data, 'base64').toString('utf8') : '',
    attributes: r.message?.attributes ?? {},
    messageId: r.message?.messageId ?? '',
    publishTime: r.message?.publishTime ?? ''
  }))
}
