// Diagnóstico da deteção: npm run scan -- <pasta-raiz>
import { scanFolder } from '../src/server/scanner'

async function main(): Promise<void> {
const root = process.argv[2]
if (!root) {
  console.error('uso: npm run scan -- <pasta-raiz>')
  process.exit(1)
}
const r = await scanFolder(root)
console.log(`Keycloak: ${r.keycloakHome ?? '(não encontrado)'}`)
for (const s of r.services) {
  const flags = [s.swaggerLib && `swagger=${s.swaggerLib}${s.swaggerPath}`, s.hasDatabase && 'db', s.usesKeycloak && 'kc-client', s.wrapperDir && 'mvnw']
    .filter(Boolean)
    .join(' ')
  console.log(`[${s.kind}] ${s.name}  ${s.relativePath}  port=${s.port ?? '-'}${s.contextPath ?? ''}  ${flags}`)
  if (s.modules) console.log(`    módulos: ${s.modules.join(', ')} · executável: ${s.runModule}`)
  if (s.swaggerGroups?.length) console.log(`    grupos swagger: ${s.swaggerGroups.join(', ')}`)
  if (s.datasource?.url) console.log(`    datasource: ${s.datasource.url} (${s.datasource.username ?? '?'})`)
  if (s.spiProviders.length) console.log(`    SPIs: ${s.spiProviders.join(', ')}`)
  if (s.profiles.length) console.log(`    perfis: ${s.profiles.join(', ')}`)
}
}

void main()
