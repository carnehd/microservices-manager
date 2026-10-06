import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, PubsubDetected, PubSubInbox, PubSubInfo, PubSubSubscription, PubSubTopic, ScanResult } from '../../../shared/types'
import { api, FRESH, type ReqOpts } from '../api'
import { RefreshIcon } from './common'

// Tópico inferido para uma subscrição sem tópico explícito (tira sufixos -sub/-subscription/-dev…).
function topicForSub(name: string): string {
  return name.replace(/[-_]sub(scription)?([-_]\w+)?$/i, '') || name
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

type Notify = (text: string, kind?: 'error' | 'info' | 'success') => void

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

// A configuração do emulador (porta, projeto, imagem, container) vive na página Settings; aqui só o que se usa no dia-a-dia.
export function PubSubView({ settings, scan, notify, fail }: {
  settings: AppSettings; scan: ScanResult | null; notify: Notify; fail: (e: unknown) => void
}) {
  const [info, setInfo] = useState<PubSubInfo | null>(null)
  const [topics, setTopics] = useState<PubSubTopic[]>([])
  const [subs, setSubs] = useState<PubSubSubscription[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  // Projeto ativo para gerir/ver (o emulador hospeda vários). Opções = o das definições + os detetados.
  const [project, setProject] = useState(settings.pubsub.projectId)
  const projectOptions = [...new Set([settings.pubsub.projectId, project, ...(scan?.services ?? []).map((s) => s.pubsub?.projectId).filter((x): x is string => !!x)])]
  const [newTopic, setNewTopic] = useState('')
  const [newSub, setNewSub] = useState('')
  const [newSubTopic, setNewSubTopic] = useState('')
  // Inbox aberta: guarda o projeto da subscrição (as mensagens são por projeto, independentes do seletor da direita).
  const [inbox, setInbox] = useState<{ project: string; sub: string; data: PubSubInbox } | null>(null)
  // Tópicos/subscrições de TODOS os projetos conhecidos (para consultar mensagens e publicar sem mudar o seletor).
  const [allTopics, setAllTopics] = useState<Array<{ project: string; name: string }>>([])
  const [allSubs, setAllSubs] = useState<Array<{ project: string; name: string; topic: string }>>([])
  // Valor dos dropdowns da esquerda: "projeto/nome" (nem project ids nem nomes de tópicos podem conter "/").
  const pk = (p: string, n: string): string => `${p}/${n}`
  const [pubTopic, setPubTopic] = useState('')
  const [pubData, setPubData] = useState('{\n  "referencia": "TEST-001",\n  "descricao": "test message",\n  "estado": "NOVA"\n}')
  // O emulador responde ao REST? (independente de haver um container local a correr — ex.: emulador remoto/partilhado)
  const [reachable, setReachable] = useState(false)
  // Popover "ⓘ" com as variáveis de ambiente para os microserviços.
  const [envOpen, setEnvOpen] = useState(false)

  // Cria no emulador os tópicos/subscrições detetados num microserviço.
  const createDetected = async (svcName: string, d: PubsubDetected) => {
    setBusy('detected:' + svcName)
    const proj = d.projectId || project // cria no projeto do microserviço
    try {
      const wanted = new Set<string>(d.topics)
      for (const s of d.subscriptions) wanted.add(s.topic || topicForSub(s.name))
      for (const t of wanted) { try { await api.pubsub.createTopic(t, proj) } catch { /* já existe */ } }
      for (const s of d.subscriptions) { try { await api.pubsub.createSubscription(s.name, s.topic || topicForSub(s.name), proj) } catch { /* já existe */ } }
      notify(`Created ${wanted.size} topic(s) and ${d.subscriptions.length} subscription(s) from ${svcName} in project ${proj}`, 'success')
      if (proj !== project) setProject(proj) // passa a ver o projeto do serviço
      else await loadEntities()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const openInbox = async (sub: string, proj: string = project) => {
    setBusy('inbox:' + sub)
    try {
      setInbox({ project: proj, sub, data: await api.pubsub.poll(sub, 50, proj) })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }
  const refreshInbox = async () => {
    if (!inbox) return
    try {
      setInbox({ ...inbox, data: await api.pubsub.poll(inbox.sub, 50, inbox.project) })
    } catch (e) {
      fail(e)
    }
  }
  const markRead = async (id?: string) => {
    if (!inbox) return
    try {
      setInbox({ ...inbox, data: await api.pubsub.markRead(inbox.sub, id, inbox.project) })
    } catch (e) {
      fail(e)
    }
  }
  const clearBox = async () => {
    if (!inbox || !window.confirm('Clear the message history for this subscription?')) return
    try {
      setInbox({ ...inbox, data: await api.pubsub.clearInbox(inbox.sub, inbox.project) })
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
      const i = pubTopic.indexOf('/')
      const [proj, topicName] = [pubTopic.slice(0, i), pubTopic.slice(i + 1)] // "projeto/tópico"
      const r = await api.pubsub.publish(topicName, pubData, undefined, proj)
      notify(`Message published to ${topicName} (project ${proj})${r.messageId ? ` (#${r.messageId})` : ''}`, 'success')
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

  // Sem opções lê a cache do servidor (entrar é instantâneo). FRESH re-corre os comandos (ficam no Terminal comum).
  const loadInfo = useCallback(async (o?: ReqOpts): Promise<PubSubInfo | null> => {
    try {
      const i = await api.pubsub.info(o)
      setInfo(i)
      return i
    } catch (e) {
      fail(e)
      return null
    }
  }, [fail])

  const projectsKey = projectOptions.join(',')
  const loadEntities = useCallback(async () => {
    try {
      const [t, s] = await Promise.all([api.pubsub.topics(project), api.pubsub.subscriptions(project)])
      setTopics(t)
      setSubs(s)
      setReachable(true) // o emulador respondeu (REST ok) — mesmo que não haja container local detetado
    } catch {
      setTopics([])
      setSubs([])
      setReachable(false)
      return
    }
    // E os de todos os projetos conhecidos, para a coluna da esquerda (mensagens/publicar) não depender do seletor.
    const projects = projectsKey.split(',').filter(Boolean)
    const per = await Promise.allSettled(projects.map(async (p) => ({
      p, t: await api.pubsub.topics(p), s: await api.pubsub.subscriptions(p)
    })))
    const at: Array<{ project: string; name: string }> = []
    const as: Array<{ project: string; name: string; topic: string }> = []
    for (const r of per) {
      if (r.status !== 'fulfilled') continue
      for (const x of r.value.t) at.push({ project: r.value.p, name: x.name })
      for (const x of r.value.s) as.push({ project: r.value.p, name: x.name, topic: x.topic })
    }
    setAllTopics(at)
    setAllSubs(as)
  }, [project, projectsKey])

  useEffect(() => {
    void loadInfo()
  }, [loadInfo])
  // Tenta sempre falar com o emulador (mesmo sem container local detetado): se responder, dá para gerir.
  useEffect(() => {
    if (info) void loadEntities()
  }, [info, loadEntities])
  // Mantém o tópico escolhido para publicar válido (default = 1º tópico de qualquer projeto).
  useEffect(() => {
    setPubTopic((cur) => (cur && allTopics.some((t) => pk(t.project, t.name) === cur) ? cur : allTopics[0] ? pk(allTopics[0].project, allTopics[0].name) : ''))
  }, [allTopics])

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

  if (!info) return <div className="muted pad">Loading…</div>

  const stateTxt = !info.engineOk ? 'engine unavailable' : info.running ? 'running' : info.exists ? 'stopped' : reachable ? 'reachable' : 'not created'
  const stateTone = info.running || reachable ? 'green' : info.exists ? 'amber' : 'muted'
  // Pode gerir (criar tópicos/subscrições, publicar, ver mensagens) se o emulador responde — container local OU remoto/existente.
  const canManage = info.running || reachable

  return (
    <main className="service">
      <div className="svc-header">
        <div className="grow">
          <h2><RefreshIcon onRefresh={() => Promise.all([loadInfo(FRESH), loadEntities()])} title="Refresh — re-run the commands that check the emulator" />Pub/Sub <span className={`pubsub-pill tone-${stateTone}`}>{stateTxt}</span></h2>
          <div className="muted small">
            Local emulator{info.running ? <> on <span className="mono">localhost:{info.port}</span></> : ''} · container <span className="mono">{info.containerName}</span> · configure it in <b>Settings → Pub/Sub</b>; container logs on the <b>Containers</b> page.
            {!info.engineOk && <span className="text-error"> Container engine unavailable{info.error ? `: ${info.error}` : ''}.</span>}
          </div>
        </div>
        {/* Barra de estado: uma ação (criar/arrancar ou parar) + ⓘ com as env vars para os microserviços */}
        <div className="pubsub-status-actions">
          {!info.running && (
            <button className="btn btn-primary" disabled={busy !== null || !info.engineOk} onClick={() => void run('start', api.pubsub.start, loadEntities)}>
              {busy === 'start' ? 'Starting…' : info.exists ? '▶ Start' : '▶ Create and start'}
            </button>
          )}
          {info.running && <button className="btn btn-danger" disabled={busy !== null} onClick={() => void run('stop', api.pubsub.stop)}>■ Stop</button>}
          <span className="pubsub-env">
            <button className="srdb-help" title="Environment variables for the microservices" onClick={() => setEnvOpen((v) => !v)}>ⓘ</button>
            {envOpen && (
              <div className="srdb-popover" onClick={(e) => e.stopPropagation()}>
                <div className="small"><b>Set in the microservice that uses Pub/Sub</b> (no credentials needed):</div>
                <Field label="PUBSUB_EMULATOR_HOST (on the host)" value={info.emulatorHostLocal} notify={notify} />
                <Field label="PUBSUB_EMULATOR_HOST (in a container)" value={info.emulatorHostContainer} notify={notify} />
                <Field label="PUBSUB_PROJECT_ID" value={info.projectId} notify={notify} />
                <div className="muted small">Host JVM → <span className="mono">localhost</span>; service in another container → same network and <span className="mono">{info.containerName}:8085</span>.</div>
              </div>
            )}
          </span>
        </div>
      </div>
    <div className="pubsub-view pubsub-split">
      {/* ESQUERDA — mensagens: consultar + criar mensagem de teste */}
      <div className="pubsub-left">
        <div className="srdb-card">
          <h3>Create test message</h3>
          {!canManage && <div className="muted small">Start the emulator (on the right) to publish.</div>}
          {canManage && (
            <>
              <div className="pubsub-form">
                <label className="inline grow">Topic
                  <select className="input mono grow" value={pubTopic} onChange={(e) => setPubTopic(e.target.value)}>
                    {projectOptions.filter((p) => allTopics.some((t) => t.project === p)).map((p) => (
                      <optgroup key={p} label={`project ${p}`}>
                        {allTopics.filter((t) => t.project === p).map((t) => <option key={pk(p, t.name)} value={pk(p, t.name)}>{t.name}</option>)}
                      </optgroup>
                    ))}
                    {!allTopics.length && <option value="">(no topics — create one on the right)</option>}
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
            <label className="inline grow" style={{ minWidth: 0 }}>Consult subscription
              <select className="input mono grow" style={{ minWidth: 0 }} value={inbox ? pk(inbox.project, inbox.sub) : ''} onChange={(e) => {
                const v = e.target.value
                if (!v) { setInbox(null); return }
                const i = v.indexOf('/')
                void openInbox(v.slice(i + 1), v.slice(0, i))
              }} title="Choose the subscription whose messages you want to consult (all projects)" disabled={!canManage}>
                <option value="">choose a subscription…</option>
                {projectOptions.filter((p) => allSubs.some((s) => s.project === p)).map((p) => (
                  <optgroup key={p} label={`project ${p}`}>
                    {allSubs.filter((s) => s.project === p).map((s) => <option key={pk(p, s.name)} value={pk(p, s.name)}>{s.name} → {s.topic}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
          </div>
          {!canManage && <div className="muted small">Start the emulator to view messages.</div>}
          {canManage && !inbox && <div className="muted small">Choose a subscription above to consult its messages.</div>}
          {inbox && (
            <>
              <div className="row">
                <span className="muted small"><span className="mono">{inbox.sub}</span> (project {inbox.project}) · {inbox.data.messages.length} message{inbox.data.messages.length === 1 ? '' : 's'}
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
        <div className="pubsub-settings" style={{ margin: 0 }}>
          <label className="field grow"><span>Project (the emulator hosts several)</span>
            <select className="input mono" value={project} onChange={(e) => setProject(e.target.value)} title="Project whose topics, subscriptions and messages you are viewing and managing">
              {projectOptions.map((p) => <option key={p} value={p}>{p}{p === settings.pubsub.projectId ? ' (default)' : ''}</option>)}
            </select>
          </label>
        </div>

        {(() => {
          const detected = (scan?.services ?? []).filter((s) => s.pubsub && (s.pubsub.topics.length || s.pubsub.subscriptions.length || s.pubsub.projectId))
          if (!detected.length) return null
          return (
            <div className="srdb-card">
              <h3>Detected in microservices <span className="count">{detected.length}</span></h3>
              <p className="muted small">Pub/Sub config read from the services' application.yaml — create the topics/subscriptions in the local emulator.</p>
              {detected.map((s) => {
                const d = s.pubsub!
                const topicsToCreate = [...new Set<string>([...d.topics, ...d.subscriptions.map((x) => x.topic || topicForSub(x.name))])]
                return (
                  <div key={s.id} className="pubsub-detected">
                    <div className="row">
                      <b className="mono small">{s.name}</b>
                      {d.projectId && <span className="muted small">· project {d.projectId}</span>}
                      <span className="grow" />
                      <button className="btn btn-sm btn-primary" disabled={!canManage || busy !== null} title={canManage ? 'Create these topics/subscriptions in the emulator' : 'Start the emulator first'} onClick={() => void createDetected(s.name, d)}>
                        {busy === 'detected:' + s.name ? 'Creating…' : '⇪ Create in emulator'}
                      </button>
                    </div>
                    {topicsToCreate.length > 0 && <div className="small mono muted">topics: {topicsToCreate.join(', ')}</div>}
                    {d.subscriptions.length > 0 && <div className="small mono muted">subs: {d.subscriptions.map((x) => `${x.name} → ${x.topic || topicForSub(x.name)}`).join(', ')}</div>}
                  </div>
                )
              })}
            </div>
          )
        })()}

        <div className="srdb-card">
          <h3>Create topics <span className="count">{topics.length}</span></h3>
          {!canManage && <div className="muted small">Start the emulator to manage topics.</div>}
          {canManage && (
            <>
              <div className="pubsub-form">
                <input className="input mono" placeholder="topic-name" value={newTopic} onChange={(e) => setNewTopic(e.target.value)} />
                <button className="btn btn-sm btn-primary" disabled={busy !== null || !newTopic.trim()} onClick={() => void run('topic', () => api.pubsub.createTopic(newTopic.trim(), project), () => { setNewTopic(''); return loadEntities() })}>Create</button>
              </div>
              <ul className="pubsub-list">
                {topics.map((t) => (
                  <li key={t.name}>
                    <span className="mono">{t.name}</span>
                    <button className="btn btn-sm btn-ghost" title="Delete" onClick={() => void run('deltopic', () => api.pubsub.deleteTopic(t.name, project), loadEntities)}>✕</button>
                  </li>
                ))}
                {!topics.length && <li className="muted small">(no topics)</li>}
              </ul>
            </>
          )}
        </div>

        <div className="srdb-card">
          <h3>Create subscriptions <span className="count">{subs.length}</span></h3>
          {!canManage && <div className="muted small">Start the emulator to manage subscriptions.</div>}
          {canManage && (
            <>
              <div className="pubsub-form">
                <input className="input mono" placeholder="subscription-name" value={newSub} onChange={(e) => setNewSub(e.target.value)} />
                <select className="input input-inline" value={newSubTopic} onChange={(e) => setNewSubTopic(e.target.value)}>
                  <option value="">topic…</option>
                  {topics.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                </select>
                <button className="btn btn-sm btn-primary" disabled={busy !== null || !newSub.trim() || !newSubTopic} onClick={() => void run('sub', () => api.pubsub.createSubscription(newSub.trim(), newSubTopic, project), () => { setNewSub(''); return loadEntities() })}>Create</button>
              </div>
              <ul className="pubsub-list">
                {subs.map((s) => (
                  <li key={s.name}>
                    <span className="mono">{s.name}</span> <span className="muted small">→ {s.topic}</span>
                    <span className="grow" />
                    <button className="btn btn-sm" disabled={busy !== null} title="Consult the message history for this subscription" onClick={() => void openInbox(s.name)}>
                      {busy === 'inbox:' + s.name ? 'opening…' : 'view messages'}
                    </button>
                    <button className="btn btn-sm btn-ghost" title="Delete" onClick={() => void run('delsub', () => api.pubsub.deleteSubscription(s.name, project), loadEntities)}>✕</button>
                  </li>
                ))}
                {!subs.length && <li className="muted small">(no subscriptions)</li>}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
    </main>
  )
}
