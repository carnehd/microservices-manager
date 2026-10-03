import { useState } from 'react'
import type { ServiceInfo, ServiceSettings } from '../../../shared/types'

function envToText(env?: Record<string, string>): string {
  return Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n')
}

function textToEnv(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return Object.keys(out).length ? out : undefined
}

export function ConfigView({
  svc, settings, defaultDebugPort, onSave
}: { svc: ServiceInfo; settings: ServiceSettings; defaultDebugPort: number; onSave: (ss: ServiceSettings) => Promise<void> }) {
  const [profile, setProfile] = useState(settings.profile ?? '')
  const [port, setPort] = useState(settings.port ? String(settings.port) : '')
  const [jvmArgs, setJvmArgs] = useState(settings.jvmArgs ?? '')
  const [extraArgs, setExtraArgs] = useState(settings.extraArgs ?? '')
  const [mavenRepoLocal, setMavenRepoLocal] = useState(settings.mavenRepoLocal ?? '')
  const [debugPort, setDebugPort] = useState(settings.debugPort ? String(settings.debugPort) : '')
  const [swaggerPath, setSwaggerPath] = useState(settings.swaggerPath ?? '')
  const [env, setEnv] = useState(envToText(settings.env))
  const [dependsOn, setDependsOn] = useState((settings.dependsOn ?? []).join(', '))
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave({
        profile: profile.trim() || undefined,
        port: parseInt(port, 10) || undefined,
        jvmArgs: jvmArgs.trim() || undefined,
        extraArgs: extraArgs.trim() || undefined,
        mavenRepoLocal: mavenRepoLocal.trim() || undefined,
        debugPort: parseInt(debugPort, 10) || undefined,
        swaggerPath: swaggerPath.trim() || undefined,
        env: textToEnv(env),
        dependsOn: dependsOn.split(',').map((x) => x.trim()).filter(Boolean)
      })
    } finally {
      setSaving(false)
    }
  }

  const ds = svc.datasource
  return (
    <div className="config">
      <section>
        <h3>Detected in the project</h3>
        <table className="kv">
          <tbody>
            <tr><th>Folder</th><td className="mono">{svc.path}</td></tr>
            <tr><th>Artifact</th><td className="mono">{[svc.groupId, svc.artifactId, svc.version].filter(Boolean).join(':')}</td></tr>
            {svc.modules && <tr><th>Modules</th><td className="mono">{svc.modules.join(', ')}<br /><span className="muted">executable: {svc.runModule} (starts with mvn -pl {svc.runModule} -am)</span></td></tr>}
            {svc.swaggerGroups?.length ? <tr><th>Swagger groups</th><td className="mono">{svc.swaggerGroups.join(', ')}</td></tr> : null}
            {svc.kind === 'spring-boot' && <tr><th>Port (config)</th><td className="mono">{svc.port ?? '—'}</td></tr>}
            {svc.contextPath && <tr><th>Context path</th><td className="mono">{svc.contextPath}</td></tr>}
            {svc.swaggerLib && <tr><th>Swagger</th><td className="mono">{svc.swaggerLib} · {svc.swaggerPath}</td></tr>}
            {ds && (
              <tr>
                <th>Datasource</th>
                <td className="mono">
                  {ds.url ?? '—'}
                  {ds.username && <><br />user: {ds.username}</>}
                  {ds.driver && <><br />driver: {ds.driver}</>}
                </td>
              </tr>
            )}
            {svc.profiles.length > 0 && <tr><th>Profiles</th><td className="mono">{svc.profiles.join(', ')}</td></tr>}
            {svc.configFiles.length > 0 && <tr><th>Config files</th><td className="mono">{svc.configFiles.join(', ')}{svc.modules ? <span className="muted"> in {svc.resourcesDir}</span> : null}</td></tr>}
            {svc.openApiFiles?.length ? <tr><th>OpenAPI contracts</th><td className="mono" style={{ whiteSpace: 'pre-wrap' }}>{svc.openApiFiles.join('\n')}</td></tr> : null}
            {svc.spiProviders.length > 0 && <tr><th>SPIs (META-INF/services)</th><td className="mono">{svc.spiProviders.join('\n')}</td></tr>}
            <tr><th>Maven wrapper</th><td className="mono">{svc.wrapperDir ?? 'not found (uses global mvn)'}</td></tr>
            <tr><th>Jar in target/</th><td className="mono">{svc.jarPath ?? '— (run Build)'}</td></tr>
          </tbody>
        </table>
      </section>

      <section>
        <h3>Startup</h3>
        <div className="form">
          {svc.kind === 'spring-boot' && (
            <>
              <label>
                Spring profile
                <input className="input" list={`profiles-${svc.id}`} value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="e.g. local,dev" />
                <datalist id={`profiles-${svc.id}`}>{svc.profiles.map((p) => <option key={p} value={p} />)}</datalist>
              </label>
              <label>
                Startup HTTP port
                <input className="input" type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder={`from application.yml: ${svc.port ?? 8080}`} />
                <span className="muted small">Passes --server.port at startup; empty = the one from the config file</span>
              </label>
              <label>
                Debug port (JDWP)
                <input className="input" type="number" value={debugPort} onChange={(e) => setDebugPort(e.target.value)} placeholder={`automatic: ${defaultDebugPort}`} />
              </label>
              <label>
                Extra JVM arguments
                <input className="input mono" value={jvmArgs} onChange={(e) => setJvmArgs(e.target.value)} placeholder="-Xmx1g -Dfoo=bar" />
              </label>
              <label>
                Swagger UI path (override)
                <input className="input mono" value={swaggerPath} onChange={(e) => setSwaggerPath(e.target.value)} placeholder={svc.swaggerPath ?? '/swagger-ui/index.html'} />
              </label>
            </>
          )}
          <label>
            Local Maven repository for this service only (-Dmaven.repo.local)
            <input className="input mono" value={mavenRepoLocal} onChange={(e) => setMavenRepoLocal(e.target.value)} placeholder="empty = the one from Settings" />
          </label>
          <label>
            Extra Maven arguments
            <input className="input mono" value={extraArgs} onChange={(e) => setExtraArgs(e.target.value)} placeholder="-Dmaven.test.skip=true -P local" />
          </label>
          {svc.kind === 'spring-boot' && (
            <label>
              Dependencies (service names, comma-separated) — used by "Start with dependencies"
              <input className="input mono" value={dependsOn} onChange={(e) => setDependsOn(e.target.value)} placeholder={svc.dependsOn?.length ? `suggested: ${svc.dependsOn.join(', ')}` : 'e.g. service-a, service-b'} />
              {svc.dependsOn?.length ? <span className="muted small">inferred from the URLs: {svc.dependsOn.join(', ')} — empty above = use these</span> : <span className="muted small">none inferred from the config URLs</span>}
            </label>
          )}
          <label>
            Environment variables (one per line, KEY=value)
            <textarea className="input mono" rows={4} value={env} onChange={(e) => setEnv(e.target.value)} placeholder={'DB_HOST=localhost\nSPRING_DATASOURCE_PASSWORD=secret'} />
          </label>
          <div>
            <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </section>
    </div>
  )
}
