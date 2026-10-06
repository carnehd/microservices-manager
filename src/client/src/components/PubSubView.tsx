import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, ContainerInfo, PubsubDetected, PubSubInbox, PubSubInfo, PubSubSubscription, PubSubTopic, ScanResult } from '../../../shared/types'
import { api } from '../api'
import { ConsoleOut } from './common'

// Porta do host mapeada para a porta 8085 do emulador num container existente (ex.: "0.0.0.0:8086->8085/tcp").
function hostPortFor8085(ports: string[]): number | null {
  const s = ports.join(' ')
  const m = s.match(/:(\d+)->8085\b/) ?? s.match(/:(\d+)->/)
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

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

export function PubSubView({ settings, scan, onSaveSettings, notify, fail }: {
  settings: AppSettings; scan: ScanResult | null; onSaveSettings: SaveSettings; notify: Notify; fail: (e: unknown) => void
}) {
  const [info, setInfo] = useState<PubSubInfo | null>(null)
  const [topics, setTopics] = useState<PubSubTopic[]>([])
  const [subs, setSubs] = useState<PubSubSubscription[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [port, setPort] = useState(String(settings.pubsub.port))
  const [projectId, setProjectId] = useState(settings.pubsub.projectId)
  const [image, setImage] = useState(settings.pubsub.image)
  const [containerName, setContainerName] = useState(settings.pubsub.containerName)
  // Projeto ativo para gerir/ver (o emulador hospeda vários). Opções = o das definições + os detetados.
  const [project, setProject] = useState(settings.pubsub.projectId)
  const projectOptions = [...new Set([settings.pubsub.projectId, project, ...(scan?.services ?? []).map((s) => s.pubsub?.projectId).filter((x): x is string => !!x)])]
  const [newTopic, setNewTopic] = useState('')
  const [newSub, setNewSub] = useState('')
  const [newSubTopic, setNewSubTopic] = useState('')
  const [inbox, setInbox] = useState<{ sub: string; data: PubSubInbox } | null>(null)
  const [pubTopic, setPubTopic] = useState('')
  const [pubData, setPubData] = useState('{\n  "referencia": "TEST-001",\n  "descricao": "test message",\n  "estado": "NOVA"\n}')
  const [cfgOpen, setCfgOpen] = useState(false)
  const [emuLog, setEmuLog] = useState('')
  const appendLog = (t: string) => setEmuLog((p) => (p ? p + '\n' : '') + t)
  const didStartup = useRef(false)
  // O emulador responde ao REST? (independente de haver um container local a correr — ex.: emulador remoto/partilhado)
  const [reachable, setReachable] = useState(false)
  // Criar um container novo (msm-pubsub) ou apontar para um já existente.
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [containerList, setContainerList] = useState<ContainerInfo[]>([])
  const [picked, setPicked] = useState('')

  const loadContainers = useCallback(async () => {
    try {
      setContainerList(await api.containers.list())
    } catch { setContainerList([]) }
  }, [])

  // Aponta a app para um container existente: guarda o nome (e a porta do host) nas definições.
  const useExisting = async () => {
    const c = containerList.find((x) => x.name === picked)
    if (!c) { notify('Choose a container', 'error'); return }
    setBusy('use-existing')
    try {
      const hp = hostPortFor8085(c.ports)
      await onSaveSettings({ pubsub: { ...settings.pubsub, containerName: c.name, ...(hp ? { port: hp } : {}) } })
      setContainerName(c.name)
      if (hp) setPort(String(hp))
      appendLog(`→ using existing container "${c.name}"${hp ? ` (host port ${hp} → 8085)` : ''}`)
      notify(`Now using container "${c.name}"`, 'success')
      await loadInfo(true)
      await loadEntities()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  // Arranca/cria o emulador mostrando o comando, o resultado e os logs do container.
  const startEmulator = async () => {
    setBusy('start')
    const name = info?.containerName ?? 'msm-pubsub'
    appendLog(`$ ${info?.image ? `podman run -d --name ${name} -p ${info.port}:8085 ${info.image} gcloud beta emulators pubsub start --host-port=0.0.0.0:8085 --project=${info.projectId}` : `start ${name}`}`)
    try {
      const msg = await api.pubsub.start()
      appendLog(msg)
      await loadInfo()
      await loadEntities()
      // logs do container (startup do emulador) — espera um pouco e vai buscar
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 700))
        try {
          const r = await api.containers.exec(['logs', '--tail', '80', name])
          const out = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join('\n')
          if (out) { appendLog('--- container logs ---\n' + out); break }
        } catch { /* ainda não há logs */ }
      }
    } catch (e) {
      appendLog(`✗ ${e instanceof Error ? e.message : String(e)}`)
      fail(e)
    } finally {
      setBusy(null)
    }
  }
  const refreshEmuLogs = async () => {
    const name = info?.containerName ?? 'msm-pubsub'
    try {
      const r = await api.containers.exec(['logs', '--tail', '120', name])
      appendLog(`--- ${name} logs (${new Date().toLocaleTimeString()}) ---\n` + [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join('\n'))
    } catch (e) { appendLog(`✗ ${e instanceof Error ? e.message : String(e)}`) }
  }

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

  const openInbox = async (sub: string) => {
    setBusy('inbox:' + sub)
    try {
      setInbox({ sub, data: await api.pubsub.poll(sub, 50, project) })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }
  const refreshInbox = async () => {
    if (!inbox) return
    try {
      setInbox({ sub: inbox.sub, data: await api.pubsub.poll(inbox.sub, 50, project) })
    } catch (e) {
      fail(e)
    }
  }
  const markRead = async (id?: string) => {
    if (!inbox) return
    try {
      setInbox({ sub: inbox.sub, data: await api.pubsub.markRead(inbox.sub, id, project) })
    } catch (e) {
      fail(e)
    }
  }
  const clearBox = async () => {
    if (!inbox || !window.confirm('Clear the message history for this subscription?')) return
    try {
      setInbox({ sub: inbox.sub, data: await api.pubsub.clearInbox(inbox.sub, project) })
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
      const r = await api.pubsub.publish(pubTopic, pubData, undefined, project)
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

  const loadInfo = useCallback(async (logCmds = false): Promise<PubSubInfo | null> => {
    try {
      const i = await api.pubsub.info()
      setInfo(i)
      if (logCmds && i.commands?.length) {
        setEmuLog((p) => (p ? p + '\n' : '')
          + `--- checking emulator state (${new Date().toLocaleTimeString()}) ---\n`
          + i.commands!.map((c) => `$ ${c}`).join('\n'))
      }
      return i
    } catch (e) {
      fail(e)
      return null
    }
  }, [fail])

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
    }
  }, [project])

  useEffect(() => {
    void loadInfo()
  }, [loadInfo])
  // Ao entrar na página: mostra na consola só os comandos básicos para configurar o container
  // (engine + estado do container). Sem `logs` — no PC da empresa os logs são lentos; usa o botão ⟳ logs.
  useEffect(() => {
    if (didStartup.current) return
    didStartup.current = true
    void (async () => {
      const e = await api.containers.engine().catch(() => null)
      const cn = e?.command ?? 'podman'
      const isDocker = /docker/i.test(cn)
      appendLog(`--- loading pub/sub page (${new Date().toLocaleTimeString()}) ---`)
      const seq: string[][] = [['version'], ...(isDocker ? [] : [['machine', 'list']]), ['ps', '-a']]
      for (const args of seq) {
        appendLog(`$ ${cn} ${args.join(' ')}`)
        try {
          const r = await api.containers.exec(args)
          const out = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join('\n')
          appendLog(`${out || '(no output)'}\n— exit ${r.code} · ${r.ms} ms`)
        } catch (err) {
          appendLog(`✗ ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    })()
  }, [])
  useEffect(() => {
    if (mode === 'existing') void loadContainers()
  }, [mode, loadContainers])
  // Tenta sempre falar com o emulador (mesmo sem container local detetado): se responder, dá para gerir.
  useEffect(() => {
    if (info) void loadEntities()
  }, [info, loadEntities])
  // Mantém o tópico escolhido para publicar válido (default = 1º tópico).
  useEffect(() => {
    setPubTopic((cur) => (cur && topics.some((t) => t.name === cur) ? cur : topics[0]?.name ?? ''))
  }, [topics])
  // Mudar de projeto limpa a inbox aberta (é de outro projeto).
  useEffect(() => { setInbox(null) }, [project])

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
    if (!image.trim() || !/^[\w.-]+$/.test(containerName.trim())) {
      notify('Invalid image or container name', 'error')
      return
    }
    setBusy('save')
    try {
      await onSaveSettings({ pubsub: { ...settings.pubsub, port: p, projectId: projectId.trim() || 'local-project', image: image.trim(), containerName: containerName.trim() } })
      notify('Pub/Sub settings saved', 'success')
      await loadInfo()
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
              <select className="input mono input-inline" value={inbox?.sub ?? ''} onChange={(e) => { if (e.target.value) void openInbox(e.target.value); else setInbox(null) }} title="Choose the subscription whose messages you want to consult" disabled={!canManage}>
                <option value="">choose a subscription…</option>
                {subs.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
            </label>
          </div>
          {!canManage && <div className="muted small">Start the emulator to view messages.</div>}
          {canManage && !inbox && <div className="muted small">Choose a subscription above to consult its messages.</div>}
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

          <div className="pubsub-mode">
            <label className={`pubsub-mode-opt${mode === 'new' ? ' on' : ''}`}>
              <input type="radio" name="pubsub-mode" checked={mode === 'new'} onChange={() => setMode('new')} /> Criar container novo
            </label>
            <label className={`pubsub-mode-opt${mode === 'existing' ? ' on' : ''}`}>
              <input type="radio" name="pubsub-mode" checked={mode === 'existing'} onChange={() => setMode('existing')} /> Usar container existente
            </label>
          </div>

          {mode === 'existing' && (
            <div className="pubsub-settings" style={{ alignItems: 'flex-end' }}>
              <label className="field grow"><span>Container existente</span>
                <select className="input mono" value={picked} onChange={(e) => setPicked(e.target.value)}>
                  <option value="">choose a container…</option>
                  {containerList.map((c) => <option key={c.id} value={c.name}>{c.name} — {c.image} ({c.state})</option>)}
                </select>
              </label>
              <button className="btn btn-sm" disabled={busy !== null} onClick={() => void loadContainers()} title="Refresh the container list">⟳</button>
              <button className="btn btn-sm btn-primary" disabled={busy !== null || !picked} onClick={() => void useExisting()}>{busy === 'use-existing' ? 'Using…' : 'Use this container'}</button>
            </div>
          )}

          <div className="pubsub-settings">
            <label className="field field-sm"><span>Port (host)</span><input className="input" value={port} onChange={(e) => setPort(e.target.value)} /></label>
            <label className="field"><span>Project ID</span><input className="input mono" value={projectId} onChange={(e) => setProjectId(e.target.value)} /></label>
            {mode === 'new' && <label className="field grow"><span>Image</span><input className="input mono" value={image} onChange={(e) => setImage(e.target.value)} title="Imagem do emulador. Podes trocar por uma alternativa (ex. no Docker Hub) se o gcr.io estiver bloqueado." /></label>}
            <label className="field"><span>Container name</span><input className="input mono" value={containerName} onChange={(e) => setContainerName(e.target.value)} /></label>
            <button className="btn btn-sm" disabled={busy !== null} onClick={() => void saveSettings()}>Save</button>
          </div>
          <p className="muted small">{mode === 'new'
            ? <>Mudar a imagem/porta/container só tem efeito num container novo — faz <b>Stop</b> e recria.</>
            : <>A app aponta para o container escolhido (assume a porta do host mapeada para 8085). Tem de ter o emulador Pub/Sub a correr nessa porta.</>}</p>
          <div className="pubsub-settings">
            <label className="field grow"><span>Managing project (o emulador hospeda vários)</span>
              <select className="input mono" value={project} onChange={(e) => setProject(e.target.value)} title="Projeto cujos tópicos/subscrições/mensagens estás a ver e a gerir">
                {projectOptions.map((p) => <option key={p} value={p}>{p}{p === settings.pubsub.projectId ? ' (default)' : ''}</option>)}
              </select>
            </label>
          </div>
          <div className="srdb-actions">
            <button className="btn btn-primary" disabled={busy !== null || !info.engineOk || info.running} onClick={() => void startEmulator()}>
              {busy === 'start' ? 'Starting…' : info.exists ? '▶ Start' : '▶ Create and start'}
            </button>
            <button className="btn btn-danger" disabled={busy !== null || !info.running} onClick={() => void run('stop', api.pubsub.stop)}>■ Stop</button>
            <button className="btn" disabled={busy !== null} onClick={() => { void loadInfo(true); if (info.running) void loadEntities() }}>⟳ Check</button>
          </div>
          {!info.engineOk && <p className="muted small">Container engine unavailable{info.error ? `: ${info.error}` : ''}.</p>}
          <div className="row" style={{ marginTop: 8 }}>
            <h4 style={{ margin: 0 }}>Container logs</h4>
            <span className="grow" />
            <button className="btn btn-sm" disabled={busy !== null || !info.exists} onClick={() => void refreshEmuLogs()}>⟳ logs</button>
            <button className="btn btn-sm btn-ghost" disabled={!emuLog} onClick={() => setEmuLog('')}>clear</button>
          </div>
          <ConsoleOut text={emuLog} placeholder="(creating/starting the emulator shows here what happens — the podman command, the result and the container logs)" style={{ margin: 0, maxHeight: 220 }} />
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
  )
}
