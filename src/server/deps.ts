import { promises as fs } from 'fs'
import { basename, dirname, join, relative, sep } from 'path'
import { XMLParser } from 'fast-xml-parser'
import type { DepsInfo, DepsModule, MavenDep, ServiceInfo } from '../shared/types'

const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pom = any

function asArray<T>(v: T | T[] | undefined | null): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v]
}
const str = (v: unknown): string | undefined => (v == null ? undefined : typeof v === 'object' ? undefined : String(v))

async function readPom(dir: string): Promise<Pom | null> {
  try {
    return xml.parse(await fs.readFile(join(dir, 'pom.xml'), 'utf8')).project ?? null
  } catch {
    return null
  }
}

/** Propriedades e dependencyManagement acumulados ao longo da cadeia de parents locais (módulo → agregador → …). */
async function chain(dir: string, stopAt: string): Promise<Pom[]> {
  const poms: Pom[] = []
  let cur = dir
  for (let i = 0; i < 6; i++) {
    const pom = await readPom(cur)
    if (!pom) break
    poms.push(pom)
    const rel = str(pom.parent?.relativePath)
    const parentDir = pom.parent ? join(cur, rel === undefined ? '..' : rel.replace(/pom\.xml$/, '') || '.') : null
    if (!parentDir || parentDir === cur) break
    // só sobe enquanto o parent estiver dentro do projeto
    if (!parentDir.startsWith(stopAt)) break
    cur = parentDir
  }
  return poms
}

export async function listDeps(svc: ServiceInfo): Promise<DepsInfo> {
  const root = svc.path
  const rootPom = await readPom(root)
  const moduleDirs: string[] = []
  if (svc.modules && rootPom) {
    // multi-módulo: percorre <modules> recursivamente
    const walk = async (dir: string, pom: Pom): Promise<void> => {
      for (const m of asArray<string>(pom.modules?.module)) {
        const d = join(dir, String(m))
        const p = await readPom(d)
        if (!p) continue
        if ((str(p.packaging) ?? 'jar') === 'pom') await walk(d, p)
        else moduleDirs.push(d)
      }
    }
    await walk(root, rootPom)
  } else moduleDirs.push(root)

  const modules: DepsModule[] = []
  let parent: DepsInfo['parent']
  let springBootVersion: string | undefined
  for (const dir of moduleDirs) {
    const poms = await chain(dir, root)
    const pom = poms[0]
    if (!pom) continue
    const props: Record<string, string> = {}
    const managed = new Map<string, string>()
    // do mais geral para o mais específico
    for (const p of [...poms].reverse()) {
      for (const [k, v] of Object.entries(p.properties ?? {})) {
        const s = str(v)
        if (s !== undefined) props[k] = s
      }
      const ver = str(p.version) ?? str(p.parent?.version)
      if (ver) props['project.version'] = ver
      for (const d of asArray<Pom>(p.dependencyManagement?.dependencies?.dependency)) {
        const v = str(d.version)
        if (v) managed.set(`${str(d.groupId)}:${str(d.artifactId)}`, v)
      }
    }
    const resolve = (v?: string): string | undefined => v?.replace(/\$\{([^}]+)\}/g, (m, k: string) => props[k] ?? m)
    const top = poms[poms.length - 1]
    const ext = top.parent && !poms.some((p) => str(p.artifactId) === str(top.parent.artifactId)) ? top.parent : undefined
    if (ext && !parent) parent = { artifactId: str(ext.artifactId) ?? '?', version: resolve(str(ext.version)) }
    if (parent?.artifactId === 'spring-boot-starter-parent') springBootVersion = parent.version
    if (!springBootVersion) springBootVersion = resolve(props['spring-boot.version'])

    const deps: MavenDep[] = asArray<Pom>(pom.dependencies?.dependency).map((d) => {
      const g = resolve(str(d.groupId)) ?? ''
      const a = resolve(str(d.artifactId)) ?? ''
      const declared = resolve(str(d.version))
      const fromMgmt = managed.get(`${g}:${a}`)
      return {
        groupId: g,
        artifactId: a,
        version: declared ? resolve(declared) : fromMgmt ? resolve(fromMgmt) : undefined,
        scope: str(d.scope) ?? 'compile',
        managed: !declared,
        optional: str(d.optional) === 'true' || undefined
      }
    })
    modules.push({ module: moduleDirs.length > 1 ? relative(root, dir).split(sep).join('/') : basename(dir), path: dir, deps })
  }
  return { parent, springBootVersion, modules, total: modules.reduce((n, m) => n + m.deps.length, 0) }
}

export function depsCommandArgs(): string[] {
  return ['-B', 'dependency:tree', '-Dstyle.color=never']
}

export const dirnameOf = dirname
