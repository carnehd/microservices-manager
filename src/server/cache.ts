// Cache (em memória) das leituras caras do motor de containers (podman/docker é lento em alguns PCs).
// Entrar numa página devolve logo a última resposta; os pollers de fundo e o botão Refresh pedem `fresh`
// e re-correm os comandos, atualizando a cache. Qualquer ação que altere containers invalida tudo.
const store = new Map<string, { value: unknown; at: number }>()
const inflight = new Map<string, Promise<unknown>>()

export async function cached<T>(key: string, fresh: boolean, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key)
  if (!fresh && hit) return hit.value as T
  // Pedidos simultâneos para a mesma chave partilham a mesma execução (não correm o comando 2x).
  const pending = inflight.get(key)
  if (pending) return pending as Promise<T>
  const p = fn().then((value) => {
    store.set(key, { value, at: Date.now() })
    return value
  }).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/** Depois de start/stop/rm/run/machine… as listagens ficam desatualizadas: limpa tudo. */
export function invalidateCache(): void {
  store.clear()
}
