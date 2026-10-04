import { useEffect } from 'react'

export interface ToastMsg {
  id: number
  text: string
  kind: 'error' | 'info' | 'success'
}

export function Toast({ msg, onClose }: { msg: ToastMsg | null; onClose: () => void }) {
  useEffect(() => {
    if (!msg) return
    const t = setTimeout(onClose, msg.kind === 'error' ? 9000 : 4000)
    return () => clearTimeout(t)
  }, [msg, onClose])
  if (!msg) return null
  return (
    <div className={`toast toast-${msg.kind}`} role="status">
      <span>{msg.text}</span>
      <button className="toast-close" onClick={onClose} aria-label="close">×</button>
    </div>
  )
}
