export type ServiceKind = 'spring-boot' | 'keycloak-spi' | 'maven-lib'

export interface DatasourceInfo {
  url?: string
  username?: string
  password?: string
  driver?: string
}

/** Microserviço tipo "SR": base de dados com database/schema próprios e tabelas geridas por Liquibase. */
export interface SrDbInfo {
  /** nome da base de dados a criar */
  database: string
  /** schema onde ficam as tabelas (e o Liquibase) */
  schema: string
  /** porta HTTP do serviço */
  httpPort?: number
  /** as tabelas são criadas pelo Liquibase no arranque */
  liquibase: boolean
  /** de onde foi detetado (docker-compose.yaml / application.yaml) */
  source: string
}

export interface SrDbStatus {
  spec: SrDbInfo
  postgresReady: boolean
  databaseExists: boolean
  schemaExists: boolean
  /** tabelas existentes no schema (sem as do Liquibase) */
  tables: string[]
  /** estado do container Postgres (para oferecer criar/arrancar quando não está acessível) */
  container: { name: string; exists: boolean; running: boolean }
}

/** Dados de uma tabela (só leitura) para visualização na app. */
export interface SrTableData {
  table: string
  columns: string[]
  rows: Array<Record<string, unknown>>
  /** há mais linhas do que o limite pedido */
  truncated: boolean
  limit: number
}

export interface ServiceInfo {
  id: string
  name: string
  artifactId: string
  groupId?: string
  version?: string
  path: string
  relativePath: string
  kind: ServiceKind
  port?: number
  contextPath?: string
  swaggerPath?: string
  swaggerLib?: 'springdoc' | 'springfox'
  /** Caminho do JSON OpenAPI (ex.: /v3/api-docs) */
  apiDocsPath?: string
  datasource?: DatasourceInfo
  /** Spec de base de dados de um microserviço SR (database/schema + Liquibase), detetado do docker-compose/application */
  srDatabase?: SrDbInfo
  hasDatabase: boolean
  usesKeycloak: boolean
  /** Pasta onde existe mvnw/mvnw.cmd (o próprio projeto ou um ancestral) */
  wrapperDir?: string
  /** Perfis detetados via application-<perfil>.* */
  profiles: string[]
  /** Ficheiros META-INF/services (SPIs Keycloak) */
  spiProviders: string[]
  /** IDs de provider declarados no código do SPI (getId()/ID = "...") — para confirmar se estão carregados */
  providerIds?: string[]
  /** Jar mais recente em target/ (se existir) */
  jarPath?: string
  configFiles: string[]
  /** Pasta src/main/resources de onde a configuração foi lida (num multi-módulo pode ser outro módulo) */
  resourcesDir: string
  /** Multi-módulo: pasta absoluta do módulo executável (boot) ou do SPI; igual a path num projeto simples */
  moduleDir?: string
  /** Multi-módulo: caminho relativo do módulo executável (para mvn -pl) */
  runModule?: string
  /** Multi-módulo: artifactIds de todos os módulos */
  modules?: string[]
  /** Grupos springdoc detetados na configuração (springdoc.group-configs) */
  swaggerGroups?: string[]
  /** Ficheiros OpenAPI/Swagger (contract-first) encontrados no projeto, relativos à pasta do serviço */
  openApiFiles?: string[]
  /** Pastas de coleções Bruno (contêm bruno.json), relativas à pasta do serviço */
  brunoCollections?: string[]
  /** Endpoints http(s) referidos na configuração (para inferir dependências) */
  refEndpoints?: Array<{ host: string; port: number }>
  /** IDs de outros serviços que este consome, inferidos dos URLs da configuração */
  dependsOn?: string[]
}

export interface DepGraph {
  nodes: Array<{ id: string; name: string; kind: ServiceKind }>
  edges: Array<{ from: string; to: string }>
}
export interface ScanResult {
  root: string
  services: ServiceInfo[]
  scannedAt: number
}

export type ProcStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed'
export type StartMode = 'run' | 'debug' | 'build' | 'clean-build' | 'clean-install' | 'spotless'
export const BUILD_MODES: ReadonlySet<StartMode> = new Set<StartMode>(['build', 'clean-build', 'clean-install', 'spotless'])

export interface ProcState {
  id: string
  status: ProcStatus
  pid?: number
  mode?: StartMode
  startedAt?: number
  endedAt?: number
  exitCode?: number | null
  debugPort?: number
  /** Porta lida do log ("Tomcat started on port 8081") */
  detectedPort?: number
}

export interface LogLine {
  ts: number
  stream: 'stdout' | 'stderr' | 'system'
  text: string
}

export interface ServiceSettings {
  profile?: string
  /** Serviço marcado como favorito (aparece no topo da lista) */
  favorite?: boolean
  /** Porta HTTP com que o serviço arranca (sobrepõe server.port do application.yml) */
  port?: number
  /** Repositório local do Maven só para este serviço (sobrepõe o das Definições) */
  mavenRepoLocal?: string
  /** Saltar testes no Build/Clean build/Clean install (-DskipTests); omissão = true */
  skipTests?: boolean
  /** Correr spotless:apply antes dos builds e do arranque */
  spotless?: boolean
  /** Dependências declaradas (ids ou nomes de serviços); vazio = usar as inferidas do scan */
  dependsOn?: string[]
  /** Arrancar sempre em debug (JDWP) */
  debug?: boolean
  /** Última composição de perfis feita na app (para regenerar com as mesmas escolhas) */
  envMix?: EnvMix
  jvmArgs?: string
  extraArgs?: string
  debugPort?: number
  swaggerPath?: string
  env?: Record<string, string>
}

export interface PostgresSettings {
  containerName: string
  image: string
  port: number
  superUser: string
  superPassword: string
  /** pasta do disco montada em /var/lib/postgresql/data; vazio = volume gerido msm-postgres-data */
  dataDir?: string
}
export interface DbServiceInfo {
  id: string
  name: string
  url: string
  host: string
  port: number
  db: string
  user: string
  hasPassword: boolean
  /** aponta para o container partilhado da app (localhost + porta configurada) */
  managed: boolean
  dbExists?: boolean
  roleExists?: boolean
}
export interface DbInfo {
  container: { name: string; image: string; exists: boolean; running: boolean; status?: string }
  ready: boolean
  engineError?: string
  services: DbServiceInfo[]
  /** containers Postgres encontrados no motor (para escolher um já existente) */
  candidates: Array<{ name: string; image: string; running: boolean }>
}

export interface KeycloakSettings {
  httpPort: number
  adminUser: string
  adminPassword: string
  /** argumentos extra do start-dev (ex.: --import-realm) */
  extraArgs?: string
  /** Container gerido pela app */
  containerName: string
  image: string
  /** Pasta do disco montada em /opt/keycloak/providers (jars dos SPIs); vazio = <raiz>/keycloak-container/providers */
  providersDir?: string
  /** Pasta do disco montada em /opt/keycloak/data (H2); vazio = <raiz>/keycloak-container/data */
  dataDir?: string
}

export interface AppSettings {
  rootFolder?: string
  javaHome?: string
  mavenCommand: string
  preferWrapper: boolean
  /** Pasta do repositório local do Maven (-Dmaven.repo.local); vazio = ~/.m2/repository */
  mavenRepoLocal?: string
  /** settings.xml a usar (-s); vazio = ~/.m2/settings.xml */
  mavenSettingsFile?: string
  baseDebugPort: number
  /** Comando do motor de containers: podman (omissão) ou docker */
  containerCommand?: string
  keycloak: KeycloakSettings
  redis: RedisSettings
  postgres: PostgresSettings
  grafana: GrafanaSettings
  pubsub: PubSubSettings
  services: Record<string, ServiceSettings>
}

/** Ligação a um Grafana (local ou da empresa) para ver logs guardados num datasource Loki. */
export interface GrafanaSettings {
  /** URL base do Grafana, ex.: http://localhost:3000 ou https://grafana.empresa.com */
  url?: string
  /** Service Account Token (role Viewer). Fica guardado localmente. */
  token?: string
  /** uid do datasource de logs (Loki) dentro do Grafana */
  datasourceUid?: string
  /** tipo do datasource (por omissão loki) */
  datasourceType?: string
  /** consulta LogQL que seleciona os logs dos microserviços, ex.: {app="my-service"} */
  query?: string
  /** Org ID do Grafana (opcional; só se houver várias organizações) */
  orgId?: number
}

export interface GrafanaLogLine {
  /** timestamp ISO */
  ts: string
  /** timestamp em nanosegundos (como o Loki devolve) */
  tsNano: string
  line: string
  level?: string
  labels: Record<string, string>
}

export interface GrafanaTestResult {
  ok: boolean
  datasourceName?: string
  datasourceType?: string
  message?: string
}

export interface KeycloakInfo {
  /** motor de containers disponível */
  valid: boolean
  image: string
  providers: string[]
  providersDir: string
  dataDir: string
  container: { name: string; image: string; exists: boolean; running: boolean; status?: string }
  /** Todos os containers cujo nome/imagem contém "keycloak" (mesmo não geridos pela app) */
  keycloakContainers: Array<{ name: string; image: string; state: string; status: string; ports: string[] }>
  engineError?: string
}

export interface DeployResult {
  jar: string
  dest: string
  keycloakRunning: boolean
  /** true se a app compilou (mvn package) antes de copiar */
  built: boolean
  /** true se o Keycloak foi reiniciado a seguir */
  restarted: boolean
  /** outras versões do mesmo artefacto removidas de providers/ */
  removed: string[]
}
export interface JarFile {
  name: string
  path: string
  /** parte do nome a seguir ao artifactId- (ex.: 1.0.0, 1.1.0-SNAPSHOT) */
  version?: string
  /** data de modificação (ms) */
  mtime: number
  size: number
}
export interface JarInfo {
  /** jars candidatos em target/ (do mais recente para o mais antigo) */
  candidates: JarFile[]
  /** jars deste artefacto já em providers/ */
  installed: JarFile[]
}

export interface KcRealm {
  id: string
  realm: string
  enabled: boolean
  displayName?: string
  /** Mostra o link "Register" na página de login */
  registrationAllowed?: boolean
}
export type KcRealmPatch = Partial<Pick<KcRealm, 'enabled' | 'displayName' | 'registrationAllowed'>>
export interface KcClient {
  id: string
  clientId: string
  enabled: boolean
  protocol?: string
  publicClient?: boolean
  rootUrl?: string
}
export interface KcUser {
  id: string
  username: string
  email?: string
  firstName?: string
  lastName?: string
  enabled: boolean
}
export interface KcNewUser {
  username: string
  email?: string
  firstName?: string
  lastName?: string
  password?: string
}
export interface KcProviderInfo {
  spi: string
  providers: string[]
}

export interface DirListing {
  /** Pasta listada ('' = lista de drives no Windows) */
  path: string
  /** undefined = sem pai (raiz); '' = voltar à lista de drives */
  parent?: string
  dirs: string[]
  drives: string[]
}

/** Pedido HTTP feito pelo servidor em nome do browser (evita CORS nos serviços). */
export interface HttpRequest {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
}
export interface HttpResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  timeMs: number
  /** Preenchido quando nem sequer houve resposta (ligação recusada, timeout) */
  error?: string
}

export interface KcNewRealm {
  realm: string
  displayName?: string
  /** De onde copiar a configuração: outro realm do servidor ou um ficheiro exportado */
  source?: { kind: 'realm'; name: string } | { kind: 'file'; name: string }
}
export interface KcNewClient {
  clientId: string
  name?: string
  publicClient: boolean
  directAccessGrants: boolean
  redirectUris: string[]
  webOrigins: string[]
}
export interface KcExportResult {
  file: string
}

/** Compositor de perfis: valores por chave escolhidos de ficheiros application-<ambiente>.* */
export interface EnvMix {
  /** Perfil de partida (normalmente "local") */
  base: string
  /** Perfil gerado → application-<target>.yml */
  target: string
  /** chave → ambiente de onde copiar o valor (chaves ausentes ficam com o valor do base) */
  choices: Record<string, string>
  /** chave → valor personalizado escrito à mão (sobrepõe-se a choices/base) */
  values?: Record<string, string>
}
export interface EnvKey {
  key: string
  path: string[]
  /** valor (como texto) por ambiente; undefined = a chave não existe nesse ficheiro */
  values: Record<string, string | undefined>
}
export interface EnvsInfo {
  resourcesDir: string
  /** ids (um por ficheiro); cada application-<ambiente> e cada ficheiro de k8s é uma entrada própria */
  profiles: string[]
  files: Record<string, string>
  /** id → etiqueta amigável para o dropdown (ex. "dev", "dev · k8s/dev.yaml") */
  labels: Record<string, string>
  /** perfis cujo ficheiro foi gerado pela app (não servem de origem) */
  generated: string[]
  /** perfis cujos valores vieram (também) da pasta k8s */
  k8s: string[]
  keys: EnvKey[]
  /** valores do application.(yaml|yml|properties) base (sem perfil); chave → valor em texto */
  defaultValues: Record<string, string>
  mix?: EnvMix
}
export interface EnvComposeResult {
  file: string
  content: string
  warnings: string[]
}

/** Containers (Podman; o comando é configurável e o Docker também funciona) */
export interface ContainerInfo {
  id: string
  name: string
  image: string
  /** running | exited | created | paused | … */
  state: string
  status: string
  ports: string[]
  created?: string
  command?: string
}
export interface ImageInfo {
  id: string
  repoTags: string[]
  size: string
  created?: string
  containers?: number
}
export interface MachineInfo {
  name: string
  running: boolean
  starting: boolean
  isDefault: boolean
  lastUp?: string
}
export interface EngineInfo {
  command: string
  available: boolean
  clientVersion?: string
  serverVersion?: string
  /** só Podman em Windows/macOS: a VM que corre os containers */
  machines?: MachineInfo[]
  error?: string
}

/** Resultado de correr um comando do motor de containers (consola da página Containers) */
export interface ContainerExecResult {
  command: string
  stdout: string
  stderr: string
  code: number
  ms: number
}

/** Git por serviço */
export interface GitChange {
  /** caminho relativo à pasta do serviço */
  path: string
  /** caminho relativo à raiz do repositório (para comandos) */
  repoPath: string
  origPath?: string
  /** M A D R C ? U … */
  code: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
}
export interface GitInfo {
  isRepo: boolean
  root?: string
  /** pasta do serviço relativa à raiz do repo ('' = é a raiz) */
  prefix?: string
  branch?: string
  detached?: boolean
  upstream?: string
  ahead?: number
  behind?: number
  lastCommit?: { hash: string; author: string; when: string; subject: string }
  remote?: string
  changes: GitChange[]
  error?: string
}
export interface GitBranch {
  name: string
  current: boolean
  remote: boolean
  upstream?: string
  when?: string
  subject?: string
}
export interface GitCommit {
  hash: string
  author: string
  when: string
  subject: string
  refs?: string
}

/** Resumo git por serviço (barra lateral) */
export type GitSummary = Record<string, { branch?: string; changes: number; ahead?: number; behind?: number }>

/** Redis */
export interface RedisSettings {
  host: string
  port: number
  password?: string
  db: number
  /** Container Podman/Docker gerido pela app (nome e imagem) */
  containerName: string
  image: string
}

/** Emulador local de Google Cloud Pub/Sub (container gerido pela app). */
export interface PubSubSettings {
  containerName: string
  image: string
  /** porta publicada no host (o emulador escuta 8085 dentro do container) */
  port: number
  projectId: string
}

export interface PubSubInfo {
  engineOk: boolean
  containerName: string
  image: string
  port: number
  projectId: string
  exists: boolean
  running: boolean
  /** para serviços no host (Host JVM) */
  emulatorHostLocal: string
  /** para serviços noutro container na mesma rede */
  emulatorHostContainer: string
  error?: string
}

export interface PubSubTopic {
  name: string
}
export interface PubSubSubscription {
  name: string
  topic: string
}

export interface PubSubMessage {
  /** payload já descodificado (o Pub/Sub guarda-o em base64) */
  data: string
  attributes: Record<string, string>
  messageId: string
  publishTime: string
}

/** Mensagem guardada no histórico (inbox) da app, com estado lida/não lida. */
export interface PubSubStoredMessage extends PubSubMessage {
  id: string
  read: boolean
  /** quando a app a recebeu (ISO) */
  receivedAt: string
}

export interface PubSubInbox {
  messages: PubSubStoredMessage[]
  unread: number
}
export interface RedisInfo {
  connected: boolean
  error?: string
  host: string
  port: number
  db: number
  version?: string
  uptimeSec?: number
  usedMemory?: string
  keys?: number
  clients?: number
  hits?: number
  misses?: number
  /** estado do container gerido pela app (se o motor de containers estiver disponível) */
  container?: { exists: boolean; running: boolean; name: string }
}
export interface RedisKeyMeta {
  key: string
  type: string
  ttl: number
}
export interface RedisScan {
  cursor: string
  keys: RedisKeyMeta[]
}
export interface RedisKeyValue extends RedisKeyMeta {
  /** string → string; hash → objeto; list/set → string[]; zset → [{member, score}]; stream → entradas */
  value: unknown
  length?: number
  memory?: number
}

/** Diagnóstico da máquina/app */
export type DiagStatus = 'ok' | 'warn' | 'fail' | 'info'
export interface DiagItem {
  group: string
  name: string
  status: DiagStatus
  detail: string
  hint?: string
}
export interface DiagReport {
  generatedAt: number
  platform: string
  items: DiagItem[]
}

/** Dependências Maven de um serviço */
export interface MavenDep {
  groupId: string
  artifactId: string
  version?: string
  scope: string
  /** versão vem do dependencyManagement/BOM do parent (não está no pom) */
  managed: boolean
  optional?: boolean
}
export interface DepsModule {
  module: string
  path: string
  deps: MavenDep[]
}
export interface DepsInfo {
  parent?: { artifactId: string; version?: string }
  springBootVersion?: string
  modules: DepsModule[]
  total: number
}

/** Coleções Bruno (ficheiros .bru) */
export interface BrunoEnv {
  name: string
  vars: Record<string, string>
}
export interface BrunoRequest {
  /** caminho do .bru relativo à pasta da coleção */
  file: string
  name: string
  seq?: number
  /** subpasta dentro da coleção ('' = raiz) */
  folder: string
  method: string
  url: string
  headers: Record<string, string>
  params: Record<string, string>
  bodyType?: string
  body?: string
  auth?: { type: string; token?: string; username?: string; password?: string }
}
export interface BrunoCollection {
  name: string
  /** pasta da coleção relativa à pasta do serviço */
  dir: string
  environments: BrunoEnv[]
  requests: BrunoRequest[]
}
