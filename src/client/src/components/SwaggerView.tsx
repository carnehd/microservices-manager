import { useState } from 'react'
import { api } from '../api'

export function SwaggerView({ url, running }: { url: string; running: boolean }) {
  const [key, setKey] = useState(0)
  if (!running) {
    return (
      <div className="empty">
        <p>Arranca o serviço para abrir o Swagger UI.</p>
        <p className="muted mono small">{url}</p>
      </div>
    )
  }
  return (
    <div className="swagger">
      <div className="toolbar">
        <span className="mono small grow ellipsis">{url}</span>
        <button className="btn btn-sm" onClick={() => setKey((k) => k + 1)}>Recarregar</button>
        <button className="btn btn-sm" onClick={() => api.openExternal(url)}>Abrir em nova aba</button>
      </div>
      <iframe key={key} src={url} className="webview" title="Swagger UI" />
      <div className="muted small pad">
        Se ficar em branco, o serviço bloqueia iframes (X-Frame-Options do Spring Security) — usa "Abrir em nova aba".
      </div>
    </div>
  )
}
