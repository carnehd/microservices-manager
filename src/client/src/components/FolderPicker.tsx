import { useCallback, useEffect, useState } from 'react'
import type { DirListing } from '../../../shared/types'
import { api } from '../api'

function joinPath(base: string, name: string): string {
  if (base.endsWith('/') || base.endsWith('\\')) return base + name
  return base + (base.includes('\\') ? '\\' : '/') + name
}

/** Seletor de pastas do servidor (o browser não consegue escolher pastas do disco). */
export function FolderPicker({ initial, onClose }: { initial?: string; onClose: (dir: string | null) => void }) {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [input, setInput] = useState(initial ?? '')
  const [error, setError] = useState<string | null>(null)

  const go = useCallback(async (p?: string) => {
    try {
      const l = await api.listDirs(p)
      setListing(l)
      setInput(l.path)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void go(initial || undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={() => onClose(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Choose folder</h3>
        <div className="row">
          <input
            className="input mono grow"
            value={input}
            autoFocus
            placeholder="C:\projects\microservices"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go(input.trim() || undefined)}
          />
          <button className="btn" onClick={() => go(input.trim() || undefined)}>Go</button>
        </div>
        {error && <div className="text-error small">{error}</div>}
        <div className="dir-list">
          {listing?.parent !== undefined && <button className="dir-item" onClick={() => go(listing.parent || undefined)}>⬆ ..</button>}
          {listing && !listing.path && listing.drives.map((d) => <button className="dir-item" key={d} onClick={() => go(d)}>💽 {d}</button>)}
          {listing?.dirs.map((d) => <button className="dir-item" key={d} onClick={() => go(joinPath(listing.path, d))}>📁 {d}</button>)}
          {listing && listing.path && !listing.dirs.length && <div className="muted small pad">No subfolders.</div>}
        </div>
        <div className="row">
          <span className="muted small mono ellipsis grow">{listing?.path}</span>
          <button className="btn" onClick={() => onClose(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={!listing?.path} onClick={() => onClose(listing!.path)}>Choose this folder</button>
        </div>
      </div>
    </div>
  )
}
