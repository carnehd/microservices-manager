import { useEffect, useState } from 'react'
import type { AppSettings } from '../../../shared/types'
import { PageHeader, type Notify } from './common'

export function SettingsView({ settings, onSave, notify, theme, onTheme }: {
  settings: AppSettings; onSave: (p: Partial<AppSettings>) => Promise<void>; notify: Notify; theme: 'dark' | 'light'; onTheme: (t: 'dark' | 'light') => void
}) {
  const [f, setF] = useState(settings)
  useEffect(() => setF(settings), [settings])
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]): void => setF((x) => ({ ...x, [k]: v }))
  const save = async (): Promise<void> => {
    await onSave({ containerCommand: f.containerCommand.trim() || 'podman', httpProxy: (f.httpProxy ?? '').trim(), httpsProxy: (f.httpsProxy ?? '').trim(), noProxy: (f.noProxy ?? '').trim(), refreshMs: Number(f.refreshMs) || 0, logsTail: Number(f.logsTail) || 300 })
    notify('Definições gravadas', 'success')
  }
  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <PageHeader title="Settings" onRefresh={() => setF(settings)} />
      <div className="card">
        <h3>Motor</h3>
        <label className="col">Comando (podman ou docker)<input className="input mono" value={f.containerCommand} onChange={(e) => set('containerCommand', e.target.value)} placeholder="podman" /></label>
        <label className="col">Auto-refresh das listas (ms; 0 = desligado — útil no PC lento)<input className="input" type="number" value={f.refreshMs} onChange={(e) => set('refreshMs', Number(e.target.value))} /></label>
        <label className="col">Linhas iniciais dos logs (tail)<input className="input" type="number" value={f.logsTail} onChange={(e) => set('logsTail', Number(e.target.value))} /></label>
      </div>
      <div className="card">
        <h3>Proxy (pulls, machine)</h3>
        <label className="col">HTTP_PROXY<input className="input mono" value={f.httpProxy ?? ''} onChange={(e) => set('httpProxy', e.target.value)} placeholder="http://user:pass@proxy.empresa.local:8080 (vazio = sem proxy)" /></label>
        <label className="col">HTTPS_PROXY (vazio = igual ao HTTP_PROXY)<input className="input mono" value={f.httpsProxy ?? ''} onChange={(e) => set('httpsProxy', e.target.value)} /></label>
        <label className="col">NO_PROXY<input className="input mono" value={f.noProxy ?? ''} onChange={(e) => set('noProxy', e.target.value)} placeholder="vazio = localhost,127.0.0.1,::1,host.containers.internal,host.docker.internal" /></label>
        <p className="muted small">A podman machine só apanha o proxy no próximo <b>Start</b> (página Machine). A password nunca aparece no Terminal.</p>
      </div>
      <div className="card">
        <h3>Aspeto</h3>
        <label className="inline">Tema <select className="input sm" value={theme} onChange={(e) => onTheme(e.target.value as 'dark' | 'light')}><option value="dark">escuro</option><option value="light">claro</option></select></label>
      </div>
      <div><button className="btn btn-primary" onClick={() => void save()}>Gravar</button></div>
    </div>
  )
}
