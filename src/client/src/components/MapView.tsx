import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DepGraph, ProcState } from '../../../shared/types'
import { api } from '../api'
import { isActive } from './common'

const NODE_W = 160
const NODE_H = 46
const COL_GAP = 90
const ROW_GAP = 22
const PAD = 24

/** Nível = distância mais longa até uma folha (dependência sem dependências). À prova de ciclos. */
function levels(nodes: string[], deps: Map<string, string[]>): Map<string, number> {
  const lvl = new Map<string, number>()
  const visiting = new Set<string>()
  const calc = (id: string): number => {
    if (lvl.has(id)) return lvl.get(id)!
    if (visiting.has(id)) return 0 // ciclo
    visiting.add(id)
    const ds = (deps.get(id) ?? []).filter((d) => nodes.includes(d))
    const v = ds.length ? Math.max(...ds.map(calc)) + 1 : 0
    visiting.delete(id)
    lvl.set(id, v)
    return v
  }
  for (const n of nodes) calc(n)
  return lvl
}

export function MapView({ states, onSelect, fail }: { states: Record<string, ProcState>; onSelect: (id: string) => void; fail: (e: unknown) => void }) {
  const [graph, setGraph] = useState<DepGraph | null>(null)

  const load = useCallback(async () => {
    try {
      setGraph(await api.depsGraph())
    } catch (e) {
      fail(e)
    }
  }, [fail])
  useEffect(() => {
    void load()
  }, [load])

  const layout = useMemo(() => {
    if (!graph) return null
    const deps = new Map<string, string[]>()
    for (const e of graph.edges) deps.set(e.from, [...(deps.get(e.from) ?? []), e.to])
    // só interessam serviços com alguma relação (têm ou são dependência)
    const related = new Set<string>()
    for (const e of graph.edges) {
      related.add(e.from)
      related.add(e.to)
    }
    const ids = graph.nodes.filter((n) => related.has(n.id)).map((n) => n.id)
    const isolated = graph.nodes.filter((n) => !related.has(n.id))
    const lvl = levels(ids, deps)
    const byLevel = new Map<number, string[]>()
    for (const id of ids) byLevel.set(lvl.get(id)!, [...(byLevel.get(lvl.get(id)!) ?? []), id])
    const pos = new Map<string, { x: number; y: number }>()
    const maxLevel = Math.max(0, ...ids.map((i) => lvl.get(i)!))
    for (let l = 0; l <= maxLevel; l++) {
      const col = (byLevel.get(l) ?? []).sort((a, b) => a.localeCompare(b))
      col.forEach((id, i) => pos.set(id, { x: PAD + (maxLevel - l) * (NODE_W + COL_GAP), y: PAD + i * (NODE_H + ROW_GAP) }))
    }
    const rows = Math.max(1, ...[...byLevel.values()].map((c) => c.length))
    const width = PAD * 2 + (maxLevel + 1) * NODE_W + maxLevel * COL_GAP
    const height = PAD * 2 + rows * (NODE_H + ROW_GAP)
    const name = (id: string): string => graph.nodes.find((n) => n.id === id)?.name ?? id
    return { deps, ids, isolated, pos, width, height, name, edges: graph.edges.filter((e) => pos.has(e.from) && pos.has(e.to)) }
  }, [graph])

  if (!graph) return <div className="empty">Building the map…</div>

  return (
    <main className="service">
      <div className="svc-header">
        <div className="grow">
          <h2>Dependency map</h2>
          <div className="muted small">Arrows point to the service being depended on (on the left). Click a service to open it.</div>
        </div>
        <button className="btn" onClick={load}>⟳ Refresh</button>
      </div>
      <div className="tab-body" style={{ overflow: 'auto', padding: 16 }}>
        {!layout || !layout.ids.length ? (
          <div className="empty">No dependencies between services detected. (They are defined by URLs in the configuration or in the Dependencies field.)</div>
        ) : (
          <svg width={layout.width} height={layout.height} style={{ minWidth: '100%' }}>
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="var(--muted)" />
              </marker>
            </defs>
            {layout.edges.map((e, i) => {
              const a = layout.pos.get(e.from)!
              const b = layout.pos.get(e.to)!
              // do lado esquerdo do dependente até ao lado direito da dependência
              const x1 = a.x, y1 = a.y + NODE_H / 2
              const x2 = b.x + NODE_W, y2 = b.y + NODE_H / 2
              const mx = (x1 + x2) / 2
              return <path key={i} d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} fill="none" stroke="var(--muted)" strokeWidth={1.5} markerEnd="url(#arrow)" opacity={0.8} />
            })}
            {layout.ids.map((id) => {
              const p = layout.pos.get(id)!
              const st = states[id]?.status
              const tone = isActive(states[id]) ? (st === 'running' ? 'var(--green)' : 'var(--amber)') : st === 'crashed' ? 'var(--red)' : 'var(--border)'
              return (
                <g key={id} transform={`translate(${p.x},${p.y})`} style={{ cursor: 'pointer' }} onClick={() => onSelect(id)}>
                  <rect width={NODE_W} height={NODE_H} rx={8} fill="var(--bg-3)" stroke={tone} strokeWidth={2} />
                  <circle cx={14} cy={NODE_H / 2} r={5} fill={tone} />
                  <text x={28} y={NODE_H / 2 + 4} fill="var(--text)" fontSize={13} fontFamily="var(--mono)">
                    {layout.name(id).length > 17 ? layout.name(id).slice(0, 16) + '…' : layout.name(id)}
                  </text>
                </g>
              )
            })}
          </svg>
        )}
        {layout && layout.isolated.length > 0 && (
          <div className="muted small pad">No dependencies: {layout.isolated.map((n) => n.name).join(', ')}</div>
        )}
      </div>
    </main>
  )
}
