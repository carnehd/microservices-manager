/** Leitura mínima de OpenAPI 3.x (e Swagger 2) para o cliente REST integrado. */

export interface OpParam {
  name: string
  in: 'path' | 'query' | 'header'
  required: boolean
  example: string
  description?: string
}

export interface Operation {
  id: string
  method: string
  path: string
  summary?: string
  tags: string[]
  params: OpParam[]
  bodyExample?: string
  bodyContentType?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

function resolveRef(doc: Any, ref: string): Any {
  if (!ref.startsWith('#/')) return undefined
  return ref.slice(2).split('/').reduce((o: Any, k) => (o == null ? undefined : o[k.replace(/~1/g, '/').replace(/~0/g, '~')]), doc)
}

function schemaType(schema: Any): string | undefined {
  const t = schema?.type
  if (Array.isArray(t)) return t.find((x) => x !== 'null')
  return t
}

export function exampleFor(schema: Any, doc: Any, depth = 0): unknown {
  if (!schema || depth > 6) return null
  if (schema.$ref) return exampleFor(resolveRef(doc, schema.$ref), doc, depth + 1)
  if (schema.example !== undefined) return schema.example
  if (schema.default !== undefined) return schema.default
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]
  if (Array.isArray(schema.allOf)) return Object.assign({}, ...schema.allOf.map((s: Any) => exampleFor(s, doc, depth + 1) ?? {}))
  const alt = schema.oneOf ?? schema.anyOf
  if (Array.isArray(alt) && alt.length) return exampleFor(alt[0], doc, depth + 1)
  const type = schemaType(schema) ?? (schema.properties ? 'object' : schema.items ? 'array' : undefined)
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries<Any>(schema.properties ?? {})) {
        if (v?.readOnly) continue
        out[k] = exampleFor(v, doc, depth + 1)
      }
      return out
    }
    case 'array':
      return [exampleFor(schema.items, doc, depth + 1)]
    case 'integer':
      return 0
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'string':
      switch (schema.format) {
        case 'date-time': return new Date().toISOString()
        case 'date': return new Date().toISOString().slice(0, 10)
        case 'uuid': return '00000000-0000-0000-0000-000000000000'
        case 'email': return 'ana@exemplo.pt'
        case 'uri': return 'https://exemplo.pt'
        default: return 'string'
      }
    default:
      return null
  }
}

function paramExample(p: Any, doc: Any): string {
  const schema = p.schema ?? p
  if (p.example !== undefined) return String(p.example)
  if (schema?.example !== undefined) return String(schema.example)
  if (schema?.default !== undefined) return String(schema.default)
  if (Array.isArray(schema?.enum) && schema.enum.length) return String(schema.enum[0])
  const t = schemaType(schema)
  if (t === 'integer' || t === 'number') return '1'
  if (t === 'boolean') return 'true'
  void doc
  return ''
}

export function parseOpenApi(doc: Any): Operation[] {
  const ops: Operation[] = []
  const paths = doc?.paths ?? {}
  for (const [path, item] of Object.entries<Any>(paths)) {
    if (!item) continue
    const shared = (item.parameters ?? []).map((p: Any) => (p.$ref ? resolveRef(doc, p.$ref) : p))
    for (const method of METHODS) {
      const op = item[method]
      if (!op) continue
      const rawParams = [...shared, ...(op.parameters ?? []).map((p: Any) => (p.$ref ? resolveRef(doc, p.$ref) : p))]
      const params: OpParam[] = []
      let bodyExample: string | undefined
      let bodyContentType: string | undefined
      for (const p of rawParams) {
        if (!p) continue
        if (p.in === 'body') {
          // Swagger 2
          bodyExample = JSON.stringify(exampleFor(p.schema, doc), null, 2)
          bodyContentType = (op.consumes ?? doc.consumes ?? ['application/json'])[0]
          continue
        }
        if (p.in !== 'path' && p.in !== 'query' && p.in !== 'header') continue
        params.push({ name: p.name, in: p.in, required: !!p.required || p.in === 'path', example: paramExample(p, doc), description: p.description })
      }
      const content = op.requestBody?.$ref ? resolveRef(doc, op.requestBody.$ref)?.content : op.requestBody?.content
      if (content && typeof content === 'object') {
        const ct = Object.keys(content).find((c) => c.includes('json')) ?? Object.keys(content)[0]
        if (ct) {
          bodyContentType = ct
          const media = content[ct]
          const ex = media.example ?? (media.examples && Object.values<Any>(media.examples)[0]?.value) ?? exampleFor(media.schema, doc)
          bodyExample = ct.includes('json') ? JSON.stringify(ex, null, 2) : typeof ex === 'string' ? ex : JSON.stringify(ex)
        }
      }
      ops.push({
        id: `${method}:${path}`,
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? op.description,
        tags: Array.isArray(op.tags) && op.tags.length ? op.tags : ['(sem tag)'],
        params,
        bodyExample,
        bodyContentType
      })
    }
  }
  return ops
}
