import { useEffect, useState, type ReactNode } from 'react'
import type { AppSettings, ContainerInfo, ScanResult } from '../../../shared/types'
import { api } from '../api'

// Porta do host mapeada para a porta 8085 do emulador num container existente (ex.: "0.0.0.0:8086->8085/tcp").
function hostPortFor8085(ports: string[]): number | null {
  const s = ports.join(' ')
  const m = s.match(/:(\d+)->8085\b/) ?? s.match(/:(\d+)->/)
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

// Cartão colapsável das Settings: fechado mostra um resumo dos valores atuais; a pesquisa abre só os que correspondem.
function Card({ title, summary, open, hidden, onToggle, children }: {
  title: string; summary: string; open: boolean; hidden: boolean; onToggle: () => void; children: ReactNode
}) {
  if (hidden) return null
  return (
    <section className={`card${open ? ' open' : ''}`}>
      <button type="button" className="card-head" onClick={onToggle} aria-expanded={open}>
        <span className="card-chevron">{open ? '▾' : '▸'}</span>
        <h3>{title}</h3>
        {!open && <span className="card-summary ellipsis" title={summary}>{summary}</span>}
      </button>
      {open && children}
    </section>
  )
}

const OPEN_KEY = 'msm.settings.open'
// Palavras-chave de cada cartão (título + nomes dos campos), para a pesquisa abrir o cartão certo
const CARD_KEYWORDS: Record<string, string> = {
  root: 'Root folder microservices root folder projects scan',
  java: 'Java / Maven JAVA_HOME jdk maven command mvn wrapper mvnw local repository .m2 settings.xml nexus mirror base debug port jdwp',
  git: 'Git git command executable git.exe path branch',
  containers: 'Containers & proxy container command podman docker engine proxy HTTP_PROXY HTTPS_PROXY NO_PROXY company network pull images java image jre start in container',
  keycloak: 'Keycloak container name image version providers folder spi jar h2 data folder http port admin user password extra arguments start-dev import-realm',
  redis: 'Redis host port db password container image',
  pubsub: 'Pub/Sub pubsub local emulator container name port project id image gcr.io existing container',
  postgres: 'Database (Postgres) postgres postgresql container port superuser password image psql'
}
const CARD_IDS = Object.keys(CARD_KEYWORDS)

export function SettingsView({
  settings, scan, onSave, onRescan, pickFolder, notify
}: {
  settings: AppSettings
  scan: ScanResult | null
  onSave: (patch: Partial<AppSettings>) => Promise<AppSettings | null>
  onRescan: () => void
  pickFolder: (initial?: string) => Promise<string | null>
  notify: (t: string, k?: 'error' | 'info' | 'success') => void
}) {
  const [form, setForm] = useState<AppSettings>(settings)
  useEffect(() => setForm(settings), [settings])
  // Ao abrir a página vai buscar as settings atuais ao servidor: podem ter mudado fora desta tab (API, outra tab).
  useEffect(() => {
    void api.getSettings().then(setForm).catch(() => { /* fica com as da app */ })
  }, [])
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]): void => setForm((f) => ({ ...f, [k]: v }))
  const setKc = <K extends keyof AppSettings['keycloak']>(k: K, v: AppSettings['keycloak'][K]): void =>
    setForm((f) => ({ ...f, keycloak: { ...f.keycloak, [k]: v } }))
  const setRedis = <K extends keyof AppSettings['redis']>(k: K, v: AppSettings['redis'][K]): void =>
    setForm((f) => ({ ...f, redis: { ...f.redis, [k]: v } }))
  const setPg = <K extends keyof AppSettings['postgres']>(k: K, v: AppSettings['postgres'][K]): void =>
    setForm((f) => ({ ...f, postgres: { ...f.postgres, [k]: v } }))
  const setPubsub = <K extends keyof AppSettings['pubsub']>(k: K, v: AppSettings['pubsub'][K]): void =>
    setForm((f) => ({ ...f, pubsub: { ...f.pubsub, [k]: v } }))
  // Containers existentes, para "usar container existente" no Pub/Sub (leitura em cache no servidor — não corre podman).
  const [containers, setContainers] = useState<ContainerInfo[]>([])
  useEffect(() => {
    void api.containers.list().then(setContainers).catch(() => setContainers([]))
  }, [])

  // Cartões abertos (por omissão todos fechados; lembrado por browser) e pesquisa de campos.
  const [open, setOpen] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]') as string[]) } catch { return new Set() }
  })
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const setOpenAll = (ids: Iterable<string>): void => {
    const s = new Set(ids)
    setOpen(s)
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...s])) } catch { /* sem storage */ }
  }
  const toggle = (id: string): void => { const s = new Set(open); if (s.has(id)) s.delete(id); else s.add(id); setOpenAll(s) }
  const matches = (id: string): boolean => !q || CARD_KEYWORDS[id].toLowerCase().includes(q)
  const card = (id: string, title: string, summary: string) => ({ title, summary, onToggle: () => toggle(id), hidden: !matches(id), open: q ? true : open.has(id) })
  const tag = (image: string): string => image.split(':').pop() ?? image

  const pick = async (cur: string | undefined, apply: (dir: string) => void): Promise<void> => {
    const dir = await pickFolder(cur)
    if (dir) apply(dir)
  }

  const save = async (): Promise<void> => {
    const rootChanged = form.rootFolder !== settings.rootFolder
    const saved = await onSave({
      rootFolder: form.rootFolder,
      // campos opcionais: '' quando esvaziados (o servidor remove-os); undefined perder-se-ia no JSON
      javaHome: (form.javaHome ?? '').trim(),
      mavenCommand: form.mavenCommand.trim() || 'mvn',
      preferWrapper: form.preferWrapper,
      mavenRepoLocal: (form.mavenRepoLocal ?? '').trim(),
      mavenSettingsFile: (form.mavenSettingsFile ?? '').trim(),
      baseDebugPort: Number(form.baseDebugPort) || 5005,
      containerCommand: (form.containerCommand ?? '').trim(),
      gitCommand: (form.gitCommand ?? '').trim(),
      javaImage: (form.javaImage ?? '').trim(),
      httpProxy: (form.httpProxy ?? '').trim(),
      httpsProxy: (form.httpsProxy ?? '').trim(),
      noProxy: (form.noProxy ?? '').trim(),
      keycloak: {
        ...form.keycloak,
        httpPort: Number(form.keycloak.httpPort) || 8080,
        extraArgs: (form.keycloak.extraArgs ?? '').trim(),
        containerName: form.keycloak.containerName?.trim() || 'msm-keycloak',
        image: form.keycloak.image?.trim() || 'quay.io/keycloak/keycloak:26.7.4',
        providersDir: (form.keycloak.providersDir ?? '').trim(),
        dataDir: (form.keycloak.dataDir ?? '').trim()
      },
      postgres: {
        ...form.postgres,
        containerName: form.postgres.containerName.trim() || 'msm-postgres',
        port: Number(form.postgres.port) || 5432,
        superUser: form.postgres.superUser.trim() || 'postgres',
        image: form.postgres.image.trim() || 'docker.io/library/postgres:16-alpine'
      },
      redis: {
        ...form.redis,
        host: form.redis.host.trim() || 'localhost',
        port: Number(form.redis.port) || 6379,
        db: Number(form.redis.db) || 0,
        password: (form.redis.password ?? '').trim(),
        containerName: form.redis.containerName.trim() || 'msm-redis',
        image: form.redis.image.trim() || 'docker.io/library/redis:7-alpine'
      },
      pubsub: {
        ...form.pubsub,
        port: Number(form.pubsub.port) || 8085,
        projectId: form.pubsub.projectId.trim() || 'local-project',
        image: form.pubsub.image.trim() || 'gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators',
        containerName: form.pubsub.containerName.trim() || 'msm-pubsub'
      }
    })
    if (saved) {
      notify('Settings saved', 'success')
      if (rootChanged && saved.rootFolder) onRescan()
    }
  }

  return (
    <main className="service">
      <div className="svc-header"><h2>Settings</h2></div>
      <div className="tab-body">
        <div className="config">
          <div className="settings-tools">
            <input className="input grow" placeholder="Find a setting… (e.g. proxy, git, port, password)" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
            {query && <button className="btn btn-sm btn-ghost" onClick={() => setQuery('')} title="clear search">✕</button>}
            <button className="btn btn-sm" onClick={() => setOpenAll(CARD_IDS)}>Expand all</button>
            <button className="btn btn-sm" onClick={() => setOpenAll([])}>Collapse all</button>
          </div>
          <Card {...card('root', 'Root folder', form.rootFolder || 'not set')}>
            <div className="form">
              <label>
                Microservices root folder
                <div className="row">
                  <input className="input mono grow" value={form.rootFolder ?? ''} onChange={(e) => set('rootFolder', e.target.value)} placeholder="C:\projects\microservices" />
                  <button className="btn" onClick={() => pick(form.rootFolder, (d) => set('rootFolder', d))}>Choose…</button>
                </div>
              </label>
            </div>
          </Card>

          <Card {...card('java', 'Java / Maven', `JAVA_HOME ${form.javaHome || 'system'} · ${form.mavenCommand || 'mvn'}${form.preferWrapper ? ' (prefer mvnw)' : ''} · debug from :${form.baseDebugPort}`)}>
            <div className="form">
              <label>
                JAVA_HOME (empty = system default)
                <div className="row">
                  <input className="input mono grow" value={form.javaHome ?? ''} onChange={(e) => set('javaHome', e.target.value)} placeholder="C:\Program Files\Java\jdk-21" />
                  <button className="btn" onClick={() => pick(form.javaHome, (d) => set('javaHome', d))}>Choose…</button>
                </div>
              </label>
              <label>
                Maven command (when there is no wrapper)
                <input className="input mono" value={form.mavenCommand} onChange={(e) => set('mavenCommand', e.target.value)} placeholder="mvn" />
              </label>
              <label className="check">
                <input type="checkbox" checked={form.preferWrapper} onChange={(e) => set('preferWrapper', e.target.checked)} /> Prefer the project's mvnw.cmd when present
              </label>
              <label>
                Local Maven repository (-Dmaven.repo.local) — where downloaded dependencies are stored
                <div className="row">
                  <input className="input mono grow" value={form.mavenRepoLocal ?? ''} onChange={(e) => set('mavenRepoLocal', e.target.value)} placeholder="empty = ~/.m2/repository (C:\Users\you\.m2\repository)" />
                  <button className="btn" onClick={() => pick(form.mavenRepoLocal, (d) => set('mavenRepoLocal', d))}>Choose…</button>
                </div>
              </label>
              <label>
                Maven settings.xml (-s) — mirrors/Nexus, proxy, credentials
                <input className="input mono" value={form.mavenSettingsFile ?? ''} onChange={(e) => set('mavenSettingsFile', e.target.value)} placeholder="empty = ~/.m2/settings.xml (C:\Users\you\.m2\settings.xml)" />
              </label>
              <label>
                Base debug port (each service uses base + index; can be changed per service)
                <input className="input" type="number" value={form.baseDebugPort} onChange={(e) => set('baseDebugPort', Number(e.target.value))} />
              </label>
            </div>
          </Card>

          <Card {...card('git', 'Git', form.gitCommand || 'git from PATH')}>
            <div className="form">
              <label>
                <span>Git command (Git tab) — empty = <span className="mono">git</span> from PATH, or Git for Windows in the usual folders</span>
                <input className="input mono" value={form.gitCommand ?? ''} onChange={(e) => set('gitCommand', e.target.value)} placeholder="C:\Program Files\Git\cmd\git.exe" />
              </label>
            </div>
          </Card>

          <Card {...card('containers', 'Containers & proxy', `${form.containerCommand || 'podman'} · proxy ${form.httpProxy || form.httpsProxy ? 'on' : 'off'}`)}>
            <div className="form">
              <label>
                Container command (Containers tab)
                <input className="input mono" value={form.containerCommand ?? ''} onChange={(e) => set('containerCommand', e.target.value)} placeholder="podman (or docker)" />
              </label>
              <label>
                Java image for "Start in container" (the service jar from target/ is mounted at /app and run with java -jar)
                <input className="input mono" value={form.javaImage ?? ''} onChange={(e) => set('javaImage', e.target.value)} placeholder="docker.io/library/eclipse-temurin:21-jre (swap for an internal mirror if docker.io is blocked)" />
              </label>
              <label>
                <span>Proxy for podman/docker — HTTP_PROXY / HTTPS_PROXY (image pulls; the podman machine picks it up on the next <b>Start machine</b>)</span>
                <div className="row">
                  <input className="input mono grow" value={form.httpProxy ?? ''} onChange={(e) => set('httpProxy', e.target.value)} placeholder="http://proxy.company.com:3128 (empty = no proxy)" />
                  <input className="input mono grow" value={form.httpsProxy ?? ''} onChange={(e) => set('httpsProxy', e.target.value)} placeholder="HTTPS_PROXY (empty = same as HTTP_PROXY)" />
                </div>
              </label>
              <label>
                NO_PROXY — hosts that bypass the proxy
                <input className="input mono" value={form.noProxy ?? ''} onChange={(e) => set('noProxy', e.target.value)} placeholder="empty = localhost,127.0.0.1,::1,host.containers.internal,host.docker.internal" />
              </label>
            </div>
          </Card>

          <Card {...card('keycloak', 'Keycloak', `${form.keycloak.containerName} · :${form.keycloak.httpPort} · ${tag(form.keycloak.image)} · admin ${form.keycloak.adminUser}`)}>
            <div className="form">
              <div className="form-row">
                <label>Container name<input className="input mono" value={form.keycloak.containerName} onChange={(e) => setKc('containerName', e.target.value)} /></label>
                <label>Image (version is the tag)<input className="input mono" style={{ minWidth: 300 }} value={form.keycloak.image} onChange={(e) => setKc('image', e.target.value)} /></label>
              </div>
              <label>
                Providers folder (mounted at /opt/keycloak/providers)
                <div className="row">
                  <input className="input mono grow" value={form.keycloak.providersDir ?? ''} onChange={(e) => setKc('providersDir', e.target.value)} placeholder="empty = <root folder>/keycloak-container/providers" />
                  <button className="btn" onClick={() => pick(form.keycloak.providersDir, (d) => setKc('providersDir', d))}>Choose…</button>
                </div>
              </label>
              <label>
                H2 data folder (mounted at /opt/keycloak/data)
                <div className="row">
                  <input className="input mono grow" value={form.keycloak.dataDir ?? ''} onChange={(e) => setKc('dataDir', e.target.value)} placeholder="empty = <root folder>/keycloak-container/data" />
                  <button className="btn" onClick={() => pick(form.keycloak.dataDir, (d) => setKc('dataDir', d))}>Choose…</button>
                </div>
              </label>
              <p className="muted small">Changes to image, folders or port only take effect with "Recreate container" on the Keycloak page (data stays on disk).</p>
              <label>
                HTTP port
                <input className="input" type="number" value={form.keycloak.httpPort} onChange={(e) => setKc('httpPort', Number(e.target.value))} />
              </label>
              <div className="form-row">
                <label>
                  Admin user
                  <input className="input" value={form.keycloak.adminUser} onChange={(e) => setKc('adminUser', e.target.value)} />
                </label>
                <label>
                  Admin password
                  <input className="input" type="password" value={form.keycloak.adminPassword} onChange={(e) => setKc('adminPassword', e.target.value)} />
                </label>
              </div>
              <p className="muted small">Used to create the admin on the container's first start (KC_BOOTSTRAP_ADMIN_*) and for the Admin REST API.</p>
              <label>
                Extra start-dev arguments
                <input className="input mono" value={form.keycloak.extraArgs ?? ''} onChange={(e) => setKc('extraArgs', e.target.value)} placeholder="--import-realm --log-level=DEBUG" />
              </label>
            </div>
          </Card>

          <Card {...card('redis', 'Redis', `${form.redis.host}:${form.redis.port}/${form.redis.db} · ${form.redis.containerName} · ${tag(form.redis.image)}`)}>
            <div className="form">
              <div className="form-row">
                <label>Host<input className="input mono" value={form.redis.host} onChange={(e) => setRedis('host', e.target.value)} /></label>
                <label>Port<input className="input" type="number" value={form.redis.port} onChange={(e) => setRedis('port', Number(e.target.value))} /></label>
                <label>DB<input className="input" type="number" value={form.redis.db} onChange={(e) => setRedis('db', Number(e.target.value))} /></label>
                <label>Password<input className="input" type="password" value={form.redis.password ?? ''} onChange={(e) => setRedis('password', e.target.value)} placeholder="(no password)" /></label>
              </div>
              <div className="form-row">
                <label>Container managed by the app<input className="input mono" value={form.redis.containerName} onChange={(e) => setRedis('containerName', e.target.value)} /></label>
                <label>Image<input className="input mono" style={{ minWidth: 280 }} value={form.redis.image} onChange={(e) => setRedis('image', e.target.value)} /></label>
              </div>
              <p className="muted small">The "Create and start container" button on the Redis page runs <span className="mono">podman run -d --name &lt;container&gt; -p &lt;port&gt;:6379 &lt;image&gt;</span> (with <span className="mono">--requirepass</span> if there is a password).</p>
            </div>
          </Card>

          <Card {...card('pubsub', 'Pub/Sub (local emulator)', `${form.pubsub.containerName} · :${form.pubsub.port} · project ${form.pubsub.projectId}`)}>
            <div className="form">
              <div className="form-row">
                <label>Container name<input className="input mono" value={form.pubsub.containerName} onChange={(e) => setPubsub('containerName', e.target.value)} /></label>
                <label>Port on the host (emulator listens on 8085 inside)<input className="input" type="number" value={form.pubsub.port} onChange={(e) => setPubsub('port', Number(e.target.value))} /></label>
                <label>Default project ID<input className="input mono" value={form.pubsub.projectId} onChange={(e) => setPubsub('projectId', e.target.value)} /></label>
              </div>
              <label>
                Image (swap for an alternative/internal mirror if gcr.io is blocked by your proxy)
                <input className="input mono" value={form.pubsub.image} onChange={(e) => setPubsub('image', e.target.value)} placeholder="gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators" />
              </label>
              <label>
                Use an existing container instead (fills name and port from a container already created elsewhere)
                <select className="input mono" value="" onChange={(e) => {
                  const c = containers.find((x) => x.name === e.target.value)
                  if (!c) return
                  setPubsub('containerName', c.name)
                  const hp = hostPortFor8085(c.ports)
                  if (hp) setPubsub('port', hp)
                }}>
                  <option value="">choose a container…</option>
                  {containers.map((c) => <option key={c.id} value={c.name}>{c.name} — {c.image} ({c.state})</option>)}
                </select>
              </label>
              <p className="muted small">Changes to image, port or container name only take effect on a new container — Stop the emulator on the Pub/Sub page and Create it again.</p>
            </div>
          </Card>

          <Card {...card('postgres', 'Database (Postgres)', `${form.postgres.containerName} · :${form.postgres.port} · ${form.postgres.superUser} · ${tag(form.postgres.image)}`)}>
            <div className="form">
              <div className="form-row">
                <label>Container<input className="input mono" value={form.postgres.containerName} onChange={(e) => setPg('containerName', e.target.value)} placeholder="name of an existing container or the managed one" /></label>
                <label>Port<input className="input" type="number" value={form.postgres.port} onChange={(e) => setPg('port', Number(e.target.value))} /></label>
              </div>
              <div className="form-row">
                <label>Superuser<input className="input mono" value={form.postgres.superUser} onChange={(e) => setPg('superUser', e.target.value)} /></label>
                <label>Password<input className="input" type="password" value={form.postgres.superPassword} onChange={(e) => setPg('superPassword', e.target.value)} /></label>
              </div>
              <label>Image (only if the app creates the container)<input className="input mono" style={{ minWidth: 300 }} value={form.postgres.image} onChange={(e) => setPg('image', e.target.value)} /></label>
              <p className="muted small">To use an existing Postgres container, put its name here (the app creates databases via <span className="mono">exec … psql</span>). The image/port only matter when the app creates the container.</p>
            </div>
          </Card>

          {q && !CARD_IDS.some(matches) && <p className="muted">No setting matches "{query}".</p>}
          <div><button className="btn btn-primary" onClick={save}>Save</button></div>
        </div>
      </div>
    </main>
  )
}
