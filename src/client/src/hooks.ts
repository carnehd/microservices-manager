import { useCallback, useEffect, useRef, useState } from 'react'
import type { LogLine } from '../../shared/types'
import { api } from './api'

const MAX_LINES = 5000

/** Buffer de logs por processo. Acumula linhas vindas do main e re-renderiza no máximo ~10x/s. */
export function useLogs() {
  const store = useRef(new Map<string, LogLine[]>())
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let pending = false
    const bump = (): void => {
      if (pending) return
      pending = true
      setTimeout(() => {
        pending = false
        setVersion((v) => v + 1)
      }, 100)
    }
    return api.onLog((id, line) => {
      let arr = store.current.get(id)
      if (!arr) {
        arr = []
        store.current.set(id, arr)
      }
      arr.push(line)
      if (arr.length > MAX_LINES) arr.splice(0, arr.length - MAX_LINES)
      bump()
    })
  }, [])

  const load = useCallback(async (id: string) => {
    const lines = await api.logs(id)
    store.current.set(id, lines)
    setVersion((v) => v + 1)
  }, [])

  const clear = useCallback(async (id: string) => {
    await api.clearLogs(id)
    store.current.set(id, [])
    setVersion((v) => v + 1)
  }, [])

  const get = useCallback((id: string): LogLine[] => store.current.get(id) ?? [], [])

  return { get, load, clear, version }
}

export type LogsApi = ReturnType<typeof useLogs>
