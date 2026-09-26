import { useSyncExternalStore } from 'react'

/** Token bearer partilhado por todos os serviços (guardado na sessão do browser). */
const KEY = 'msm.token'
const listeners = new Set<() => void>()

export function getToken(): string {
  try {
    return sessionStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

export function setToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(KEY, token)
    else sessionStorage.removeItem(KEY)
  } catch {
    /* sessionStorage indisponível */
  }
  listeners.forEach((l) => l())
}

export function useAuthToken(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getToken
  )
}

export interface JwtInfo {
  username?: string
  issuer?: string
  exp?: number
}

/** Lê o payload de um JWT sem validar (só para mostrar quem é / quando expira). */
export function decodeJwt(token: string): JwtInfo | null {
  try {
    const payload = token.split('.')[1]
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return { username: json.preferred_username ?? json.sub, issuer: json.iss, exp: json.exp }
  } catch {
    return null
  }
}
