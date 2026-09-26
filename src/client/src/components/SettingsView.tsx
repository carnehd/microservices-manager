import { useEffect, useState } from 'react'
import type { AppSettings, ScanResult } from '../../../shared/types'

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
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]): void => setForm((f) => ({ ...f, [k]: v }))
  const setKc = <K extends keyof AppSettings['keycloak']>(k: K, v: AppSettings['keycloak'][K]): void =>
    setForm((f) => ({ ...f, keycloak: { ...f.keycloak, [k]: v } }))
  const setRedis = <K extends keyof AppSettings['redis']>(k: K, v: AppSettings['redis'][K]): void =>
    setForm((f) => ({ ...f, redis: { ...f.redis, [k]: v } }))

  const pick = async (cur: string | undefined, apply: (dir: string) => void): Promise<void> => {
    const dir = await pickFolder(cur)
    if (dir) apply(dir)
  }

  const save = async (): Promise<void> => {
    const rootChanged = form.rootFolder !== settings.rootFolder
    const saved = await onSave({
      rootFolder: form.rootFolder,
      javaHome: form.javaHome?.trim() || undefined,
      mavenCommand: form.mavenCommand.trim() || 'mvn',
      preferWrapper: form.preferWrapper,
      baseDebugPort: Number(form.baseDebugPort) || 5005,
      containerCommand: form.containerCommand?.trim() || undefined,
      keycloak: {
        ...form.keycloak,
        home: form.keycloak.home?.trim() || undefined,
        httpPort: Number(form.keycloak.httpPort) || 8080,
        extraArgs: form.keycloak.extraArgs?.trim() || undefined
      },
      redis: {
        ...form.redis,
        host: form.redis.host.trim() || 'localhost',
        port: Number(form.redis.port) || 6379,
        db: Number(form.redis.db) || 0,
        password: form.redis.password?.trim() || undefined,
        containerName: form.redis.containerName.trim() || 'msm-redis',
        image: form.redis.image.trim() || 'docker.io/library/redis:7-alpine'
      }
    })
    if (saved) {
      notify('Definições guardadas', 'success')
      if (rootChanged && saved.rootFolder) onRescan()
    }
  }

  return (
    <main className="service">
      <div className="svc-header"><h2>Definições</h2></div>
      <div className="tab-body">
        <div className="config">
          <section>
            <h3>Pastas</h3>
            <div className="form">
              <label>
                Pasta raiz dos microserviços
                <div className="row">
                  <input className="input mono grow" value={form.rootFolder ?? ''} onChange={(e) => set('rootFolder', e.target.value)} placeholder="C:\projetos\microservicos" />
                  <button className="btn" onClick={() => pick(form.rootFolder, (d) => set('rootFolder', d))}>Escolher…</button>
                </div>
              </label>
              <label>
                Pasta do Keycloak (contém bin/kc.bat)
                <div className="row">
                  <input className="input mono grow" value={form.keycloak.home ?? ''} onChange={(e) => setKc('home', e.target.value)} placeholder="C:\keycloak-26.0.0" />
                  <button className="btn" onClick={() => pick(form.keycloak.home, (d) => setKc('home', d))}>Escolher…</button>
                  {scan?.keycloakHome && scan.keycloakHome !== form.keycloak.home && (
                    <button className="btn" title={scan.keycloakHome} onClick={() => setKc('home', scan.keycloakHome)}>Usar a detetada</button>
                  )}
                </div>
              </label>
            </div>
          </section>

          <section>
            <h3>Java / Maven</h3>
            <div className="form">
              <label>
                JAVA_HOME (vazio = o do sistema)
                <div className="row">
                  <input className="input mono grow" value={form.javaHome ?? ''} onChange={(e) => set('javaHome', e.target.value)} placeholder="C:\Program Files\Java\jdk-21" />
                  <button className="btn" onClick={() => pick(form.javaHome, (d) => set('javaHome', d))}>Escolher…</button>
                </div>
              </label>
              <label>
                Comando Maven (quando não há wrapper)
                <input className="input mono" value={form.mavenCommand} onChange={(e) => set('mavenCommand', e.target.value)} placeholder="mvn" />
              </label>
              <label className="check">
                <input type="checkbox" checked={form.preferWrapper} onChange={(e) => set('preferWrapper', e.target.checked)} /> Preferir mvnw.cmd do projeto quando existir
              </label>
              <label>
                Comando de containers (separador Containers)
                <input className="input mono" value={form.containerCommand ?? ''} onChange={(e) => set('containerCommand', e.target.value)} placeholder="podman (ou docker)" />
              </label>
              <label>
                Porta de debug base (cada serviço usa base + índice; pode ser alterada por serviço)
                <input className="input" type="number" value={form.baseDebugPort} onChange={(e) => set('baseDebugPort', Number(e.target.value))} />
              </label>
            </div>
          </section>

          <section>
            <h3>Keycloak</h3>
            <div className="form">
              <label>
                Porta HTTP (start-dev --http-port)
                <input className="input" type="number" value={form.keycloak.httpPort} onChange={(e) => setKc('httpPort', Number(e.target.value))} />
              </label>
              <div className="form-row">
                <label>
                  Utilizador admin
                  <input className="input" value={form.keycloak.adminUser} onChange={(e) => setKc('adminUser', e.target.value)} />
                </label>
                <label>
                  Password admin
                  <input className="input" type="password" value={form.keycloak.adminPassword} onChange={(e) => setKc('adminPassword', e.target.value)} />
                </label>
              </div>
              <p className="muted small">Usadas para criar o admin no primeiro arranque (KC_BOOTSTRAP_ADMIN_* / KEYCLOAK_ADMIN*) e para a Admin REST API.</p>
              <label>
                Argumentos extra do start-dev
                <input className="input mono" value={form.keycloak.extraArgs ?? ''} onChange={(e) => setKc('extraArgs', e.target.value)} placeholder="--import-realm --log-level=DEBUG" />
              </label>
            </div>
          </section>

          <section>
            <h3>Redis</h3>
            <div className="form">
              <div className="form-row">
                <label>Host<input className="input mono" value={form.redis.host} onChange={(e) => setRedis('host', e.target.value)} /></label>
                <label>Porta<input className="input" type="number" value={form.redis.port} onChange={(e) => setRedis('port', Number(e.target.value))} /></label>
                <label>DB<input className="input" type="number" value={form.redis.db} onChange={(e) => setRedis('db', Number(e.target.value))} /></label>
                <label>Password<input className="input" type="password" value={form.redis.password ?? ''} onChange={(e) => setRedis('password', e.target.value)} placeholder="(sem password)" /></label>
              </div>
              <div className="form-row">
                <label>Container gerido pela app<input className="input mono" value={form.redis.containerName} onChange={(e) => setRedis('containerName', e.target.value)} /></label>
                <label>Imagem<input className="input mono" style={{ minWidth: 280 }} value={form.redis.image} onChange={(e) => setRedis('image', e.target.value)} /></label>
              </div>
              <p className="muted small">O botão "Criar e arrancar container" na página Redis faz <span className="mono">podman run -d --name &lt;container&gt; -p &lt;porta&gt;:6379 &lt;imagem&gt;</span> (com <span className="mono">--requirepass</span> se houver password).</p>
            </div>
          </section>

          <div><button className="btn btn-primary" onClick={save}>Guardar</button></div>
        </div>
      </div>
    </main>
  )
}
