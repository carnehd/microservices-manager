import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, PubSubInbox, PubSubInfo, PubSubSubscription, PubSubTopic } from '../../../shared/types'
import { api } from '../api'

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

type Notify = (text: string, kind?: 'error' | 'info' | 'success') => void
type SaveSettings = (patch: Partial<AppSettings>) => Promise<AppSettings | null>

function Field({ label, value, notify }: { label: string; value: string; notify: Notify }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      notify('Copied', 'success')
    } catch {
      notify('Could not copy', 'error')
    }
  }
  return (
    <div className="srdb-field">
      <span className="srdb-field-label">{label}</span>
      <span className="srdb-field-value mono">{value}</span>
      <button className="btn btn-sm" title={`Copy ${label}`} onClick={() => void copy()}>copy</button>
    </div>
  )
}

export function PubSubView({ settings, onSaveSettings, notify, fail }: {
  settings: AppSettings; onSaveSettings: SaveSettings; notify: Notify; fail: (e: unknown) => void
}) {
  const [info, setInfo] = useState<PubSubInfo | null>(null)
  const [topics, setTopics] = useState<PubSubTopic[]>([])
  const [subs, setSubs] = useState<PubSubSubscription[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [port, setPort] = useState(String(settings.pubsub.port))
  const [projectId, setProjectId] = useState(settings.pubsub.projectId)
  const [newTopic, setNewTopic] = useState('')
  const [newSub, setNewSub] = useState('')
  const [newSubTopic, setNewSubTopic] = useState('')
  const [inbox, setInbox] = useState<{ sub: string; data: PubSubInbox } | null>(null)
  const [pubTopic, setPubTopic] = useState('')
  const [pubData, setPubData] = useState('{\n  "referencia": "TEST-001",\n  "descricao": "test message",\n  "estado": "NOVA"\n}')
  const [cfgOpen, setCfgOpen] = useState(false)

  const openInbox = async (sub: string) => {
    setBusy('inbox:' + sub)
    try {
      setInbox({ sub, data: await api.pubsub.poll(sub) })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }
  const refreshInbox = async () => {
    if (!inbox) return
    try {
      setInbox({ sub: inbox.sub, data: await api.pubsub.poll(inbox.sub) })
    } catch (e) {
      fail(e)
    }
  }
  const markRead = async (id?: string) => {
    if (!inbox) return
    try {
      setInbox({ sub: inbox.sub, data: await api.pubsub.markRead(inbox.sub, id) })
    } catch (e) {
      fail(e)
    }
  }
  const clearBox = async () => {
    if (!inbox || !window.confirm('Clear the message history for this subscription?')) return
    try {
      setInbox({ sub: inbox.sub, data: await api.pubsub.clearInbox(inbox.sub) })
    } catch (e) {
      fail(e)
    }
  }
  const publishTest = async () => {
    if (!pubTopic) {
      notify('Choose a topic', 'error')
      return
    }
    setBusy('publish')
    try {
      const r = await api.pubsub.publish(pubTopic, pubData)
      notify(`Message published to ${pubTopic}${r.messageId ? ` (#${r.messageId})` : ''}`, 'success')
      if (inbox) await refreshInbox()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }
  const formatPayload = () => {
    try {
      setPubData(JSON.stringify(JSON.parse(pubData), null, 2))
    } catch {
      notify('Payload is not valid JSON', 'error')
    }
  }

  const loadInfo = useCallback(async () => {
    try {
      setInfo(await api.pubsub.info())
    } catch (e) {
      fail(e)
    }
  }, [fail])

  const loadEntities = useCallback(async () => {
    try {
      const [t, s] = await Promise.all([api.pubsub.topics(), api.pubsub.subscriptions()])
      setTopics(t)
      setSubs(s)
    } catch {
      setTopics([])
      setSubs([])
    }
  }, [])

  useEffect(() => {
    void loadInfo()
  }, [loadInfo])
  useEffect(() => {
    if (info?.running) void loadEntities()
  }, [info?.running, loadEntities])
  // Mantém o tópico escolhido para publicar válido (default = 1º tópico).
  useEffect(() => {
    setPubTopic((cur) => (cur && topics.some((t) => t.name === cur) ? cur : topics[0]?.name ?? ''))
  }, [topics])

  const run = async (key: string, fn: () => Promise<unknown>, after?: () => Promise<unknown> | void) => {
    setBusy(key)
    try {
      const r = await fn()
      if (typeof r === 'string' && r) notify(r, 'success')
      await loadInfo()
      if (after) await after()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const saveSettings = async () => {
    const p = Number(port)
    if (!Number.isFinite(p) || p <= 0) {
      notify('Invalid port', 'error')
      return
    }
    setBusy('save')
    try {
      await onSaveSettings({ pubsub: { ...settings.pubsub, port: p, projectId: projectId.trim() || 'local-project' } })
      notify('Pub/Sub settings saved', 'success')
      await loadInfo()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  if (!info) return <div className="muted pad">Loading…</div>

  const stateTxt = !info.engineOk ? 'engine unavailable' : info.running ? 'running' : info.exists ? 'stopped' : 'not created'
  const stateTone = info.running ? 'green' : info.exists ? 'amber' : 'muted'

  return (
    <div className="pubsub-view pubsub-split">
      {/* ESQUERDA — mensagens: consultar + criar mensagem de teste */}
      <div className="pubsub-left">
        <div className="srdb-card">
          <h3>Create test message</h3>
          {!info.running && <div className="muted small">Start the emulator (on the right) to publish.</div>}
          {info.running && (
            <>
              <div className="pubsub-form">
                <label className="inline grow">Topic
                  <select className="input mono grow" value={pubTopic} onChange={(e) => setPubTopic(e.target.value)}>
                    {topics.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                    {!topics.length && <option value="">(no topics — create one on the right)</option>}
                  </select>
                </label>
              </div>
              <textarea className="input mono bruno-body" value={pubData} onChange={(e) => setPubData(e.target.value)} spellCheck={false} placeholder='{ "key": "value" }' />
              <div className="row">
                <button className="btn btn-sm" onClick={formatPayload} title="Format as JSON">Format JSON</button>
                <span className="grow" />
                <button className="btn btn-sm btn-primary" disabled={busy !== null || !pubTopic} onClick={() => void publishTest()}>{busy === 'publish' ? 'Publishing…' : 'Publish'}</button>
              </div>
              <p className="muted small">Publishes to the topic. To see it, open a subscription on that topic below and press <b>refresh</b>.</p>
            </>
          )}
        </div>

        <div className="srdb-card pubsub-messages">
          <div className="row">
            <h3 style={{ margin: 0 }}>Messages</h3>
            <span className="grow" />
            <label className="inline">Consult subscription
              <select className="input mono input-inline" value={inbox?.sub ?? ''} onChange={(e) => { if (e.target.value) void openInbox(e.target.value); else setInbox(null) }} title="Choose the subscription whose messages you want to consult" disabled={!info.running}>
                <option value="">choose a subscription…</option>
                {subs.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
            </label>
          </div>
          {!info.running && <div className="muted small">Start the emulator to view messages.</div>}
          {info.running && !inbox && <div className="muted small">Choose a subscription above to consult its messages.</div>}
          {inbox && (
            <>
              <div className="row">
                <span className="muted small">{inbox.data.messages.length} message{inbox.data.messages.length === 1 ? '' : 's'}
                  {inbox.data.unread > 0 && <span className="pubsub-unread-badge">{inbox.data.unread} unread</span>}
                </span>
                <span className="grow" />
                <button className="btn btn-sm" onClick={() => void refreshInbox()}>⟳ refresh</button>
                <button className="btn btn-sm" disabled={inbox.data.unread === 0} onClick={() => void markRead()}>mark all read</button>
                <button className="btn btn-sm btn-ghost" onClick={() => void clearBox()}>clear</button>
              </div>
              {inbox.data.messages.length === 0 && <div className="muted small">No messages in the history. Publish a test message above (or create an operation) and press <b>refresh</b>.</div>}
              {[...inbox.data.messages].reverse().map((m) => (
                <div className={`pubsub-msg ${m.read ? 'read' : 'unread'}`} key={m.id} title={m.read ? 'read' : 'click to mark as read'} onClick={() => { if (!m.read) void markRead(m.id) }}>
                  <div className="small mono pubsub-msg-head">
                    <span className="pubsub-dot">{m.read ? '○' : '●'}</span> #{m.messageId} · {m.publishTime}{m.attributes && Object.keys(m.attributes).length ? ' · ' + JSON.stringify(m.attributes) : ''}
                  </div>
                  <pre className="resp-body">{prettyJson(m.data)}</pre>
                </div>
              ))}
              <p className="muted small">Messages are pulled from the emulator and kept here (history). <b>Unread</b> (●) are marked read when clicked. History is lost if the app restarts.</p>
            </>
          )}
        </div>
      </div>

      {/* DIREITA — configurações: emulador, config dos microserviços, tópicos e subscrições */}
      <div className="pubsub-right">
        <div className="srdb-card">
          <h3>Local Pub/Sub emulator <span className={`pubsub-pill tone-${stateTone}`}>{stateTxt}</span></h3>
          <p className="muted small">Official Google Cloud Pub/Sub emulator, running in a container. Microservices use it by setting <span className="mono">PUBSUB_EMULATOR_HOST</span> (no credentials).</p>
          <div className="pubsub-settings">
            <label className="field field-sm"><span>Port (host)</span><input className="input" value={port} onChange={(e) => setPort(e.target.value)} /></label>
            <label className="field"><span>Project ID</span><input className="input mono" value={projectId} onChange={(e) => setProjectId(e.target.value)} /></label>
            <button className="btn btn-sm" disabled={busy !== null} onClick={() => void saveSettings()}>Save</button>
          </div>
          <div className="srdb-actions">
            <button className="btn btn-primary" disabled={busy !== null || !info.engineOk || info.running} onClick={() => void run('start', api.pubsub.start, loadEntities)}>
              {busy === 'start' ? 'Starting…' : info.exists ? '▶ Start' : '▶ Create and start'}
            </button>
            <button className="btn btn-danger" disabled={busy !== null || !info.running} onClick={() => void run('stop', api.pubsub.stop)}>■ Stop</button>
            <button className="btn" disabled={busy !== null} onClick={() => { void loadInfo(); if (info.running) void loadEntities() }}>⟳ Check</button>
          </div>
          {!info.engineOk && <p className="muted small">Container engine unavailable{info.error ? `: ${info.error}` : ''}.</p>}
        </div>

        <div className="srdb-card">
          <button className="pubsub-collapse" onClick={() => setCfgOpen((v) => !v)} title={cfgOpen ? 'collapse' : 'expand'}>
            <span className="pubsub-chevron">{cfgOpen ? '▾' : '▸'}</span>
            <h3 style={{ margin: 0 }}>Configuration for the microservices</h3>
          </button>
          {cfgOpen && (
            <>
              <p className="muted small">Set these environment variables in the microservice that will use Pub/Sub:</p>
              <div className="srdb-fields">
                <Field label="PUBSUB_EMULATOR_HOST (on the host)" value={info.emulatorHostLocal} notify={notify} />
                <Field label="PUBSUB_EMULATOR_HOST (in a container)" value={info.emulatorHostContainer} notify={notify} />
                <Field label="PUBSUB_PROJECT_ID" value={info.projectId} notify={notify} />
              </div>
              <p className="muted small">On the host (Host JVM) use <span className="mono">localhost</span>; in a service in another container, connect it to the same network and use <span className="mono">{info.containerName}:8085</span>.</p>
            </>
          )}
        </div>

        <div className="srdb-card">
          <h3>Create topics <span className="count">{topics.length}</span></h3>
          {!info.running && <div className="muted small">Start the emulator to manage topics.</div>}
          {info.running && (
            <>
              <div className="pubsub-form">
                <input className="input mono" placeholder="topic-name" value={newTopic} onChange={(e) => setNewTopic(e.target.value)} />
                <button className="btn btn-sm btn-primary" disabled={busy !== null || !newTopic.trim()} onClick={() => void run('topic', () => api.pubsub.createTopic(newTopic.trim()), () => { setNewTopic(''); return loadEntities() })}>Create</button>
              </div>
              <ul className="pubsub-list">
                {topics.map((t) => (
                  <li key={t.name}>
                    <span className="mono">{t.name}</span>
                    <button className="btn btn-sm btn-ghost" title="Delete" onClick={() => void run('deltopic', () => api.pubsub.deleteTopic(t.name), loadEntities)}>✕</button>
                  </li>
                ))}
                {!topics.length && <li className="muted small">(no topics)</li>}
              </ul>
            </>
          )}
        </div>

        <div className="srdb-card">
          <h3>Create subscriptions <span className="count">{subs.length}</span></h3>
          {!info.running && <div className="muted small">Start the emulator to manage subscriptions.</div>}
          {info.running && (
            <>
              <div className="pubsub-form">
                <input className="input mono" placeholder="subscription-name" value={newSub} onChange={(e) => setNewSub(e.target.value)} />
                <select className="input input-inline" value={newSubTopic} onChange={(e) => setNewSubTopic(e.target.value)}>
                  <option value="">topic…</option>
                  {topics.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                </select>
                <button className="btn btn-sm btn-primary" disabled={busy !== null || !newSub.trim() || !newSubTopic} onClick={() => void run('sub', () => api.pubsub.createSubscription(newSub.trim(), newSubTopic), () => { setNewSub(''); return loadEntities() })}>Create</button>
              </div>
              <ul className="pubsub-list">
                {subs.map((s) => (
                  <li key={s.name}>
                    <span className="mono">{s.name}</span> <span className="muted small">→ {s.topic}</span>
                    <span className="grow" />
                    <button className="btn btn-sm" disabled={busy !== null} title="Consult the message history for this subscription" onClick={() => void openInbox(s.name)}>
                      {busy === 'inbox:' + s.name ? 'opening…' : 'view messages'}
                    </button>
                    <button className="btn btn-sm btn-ghost" title="Delete" onClick={() => void run('delsub', () => api.pubsub.deleteSubscription(s.name), loadEntities)}>✕</button>
                  </li>
                ))}
                {!subs.length && <li className="muted small">(no subscriptions)</li>}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
