# Microservices Manager

Painel local, no browser, para trabalhar no dia a dia com um conjunto de **microserviços Spring Boot (Maven)**,
**SPIs de Keycloak**, um **Keycloak** standalone, **containers** (Podman/Docker) e um **Redis** — tudo a partir
de uma única página em `http://localhost:3210`.

## Objetivo

Substituir a dúzia de terminais, scripts e consolas que um programador abre para desenvolver localmente:

- arrancar/parar cada microserviço (normal ou em debug) e ver os logs em tempo real;
- testar os endpoints (Swagger ou cliente REST integrado, já com token do Keycloak);
- alternar configurações entre ambientes (`local`, `dev`, `sit`, `uat`…) sem editar ficheiros à mão;
- gerir o Keycloak local (arrancar, realms, clients, utilizadores, instalar SPIs);
- ver o que está a correr em containers e na cache Redis;
- fazer as operações git básicas de cada serviço;
- e, numa máquina nova, perceber de imediato o que falta instalar (Diagnóstico).

Corre como um pequeno servidor Node na própria máquina (Windows, macOS ou Linux); a interface abre no
browser. Não precisa de instalação nem de permissões de administrador.

---

## Instalação e arranque

### Requisitos

| Para | Precisa de |
|---|---|
| A app | [Node.js](https://nodejs.org) 20 ou superior |
| Arrancar/compilar microserviços | JDK 17+ (**21** se usares Keycloak 26) e Maven no `PATH` **ou** `mvnw.cmd`/`mvnw` nos projetos |
| Separador Git | Git |
| Keycloak | Distribuição descompactada (pasta com `bin\kc.bat`) |
| Containers e Redis | Podman (Windows: Podman Desktop + WSL2) ou Docker |

Nenhuma destas ferramentas é obrigatória: o que faltar aparece a amarelo/vermelho na página **Diagnóstico** e
só desativa a funcionalidade correspondente.

### Windows

1. Descompacta o zip da app (ou copia a pasta do projeto **sem** `node_modules/` e `dist/`).
2. Duplo clique em **`start.cmd`**: na primeira vez instala as dependências e compila; depois abre o browser.
3. **Definições** → pasta raiz dos microserviços (e a pasta do Keycloak, se tiveres) → Guardar → **Rescan**.

Manualmente: `npm install`, `npm run build`, `npm start`. Porta alternativa: `set MSM_PORT=4000` antes do
`npm start`. Se a app já estiver a correr noutra janela, um segundo `npm start` limita-se a abrir o browser nela.

### macOS / Linux

```bash
npm install
npm run build
npm start
```

### Onde ficam as definições

`%APPDATA%\microservices-manager\settings.json` (Windows) ou `~/.config/microservices-manager/settings.json`
(macOS/Linux). Contém a pasta raiz, Keycloak, Redis, comando de containers e as definições por serviço (perfil,
porta, debug, escolhas de ambientes).

### Permissões

O servidor só aceita ligações de `127.0.0.1`; todas as portas usadas são > 1024. Não precisa de administrador
para correr. O Windows Defender pode perguntar se deixa o `java.exe` aceitar ligações — cancelar não afeta o uso
em `localhost`. Só a instalação de ferramentas (Node, JDK, Podman/WSL2) pode pedir elevação.

---

## Funcionalidades

### Deteção dos projetos (Rescan)

A app percorre a **pasta raiz** (até 6 níveis; ignora `target/`, `node_modules/`, `src/`, `build/`, `.git/`…) e
classifica cada `pom.xml`:

| Tipo | Critério |
|---|---|
| **Spring Boot** (arranca, debug, Swagger…) | tem `spring-boot-maven-plugin` **ou** uma classe `@SpringBootApplication` |
| **Keycloak SPI** (instalar no Keycloak) | ficheiros em `src/main/resources/META-INF/services/org.keycloak.*` ou dependência `org.keycloak` |
| **Outros Maven** (só build) | tudo o resto |

**Multi-módulo (hexagonal)** — um agregador (`packaging=pom`) com um único módulo executável (ex.: `domain`,
`application`, `infrastructure`, `boot`) aparece como **um só serviço**: arranca com
`mvn -pl <boot> -am install && mvn -pl <boot> spring-boot:run`, o build compila todos os módulos e a
configuração/perfis são lidos do módulo que os tiver. Agregadores com vários executáveis (monorepo) listam cada um.

De cada Spring Boot lê `application.properties/yml`: porta, context-path, datasource, perfis
(`application-<perfil>.*`), Swagger (springdoc/springfox, incluindo grupos `springdoc.group-configs`),
base de dados, uso de Keycloak (oauth2 resource server/client) e o Maven wrapper (na pasta ou num ancestral).
Uma pasta com `bin/kc.bat` dentro da raiz é detetada como Keycloak.

Diagnóstico sem UI: `npm run scan -- C:\pasta\dos\microservicos`.

### Lista de serviços (barra lateral)

Nome, estado (ponto verde a correr), branch git atual e número de alterações por commitar. **Arrancar todos** /
**Parar todos** no topo.

### Página de cada microserviço

- **Cabeçalho**: nome, versão, estado (`a correr · porta 8081 · debug 5005`).
- **Debug** (interruptor, guardado por serviço) + **▶ Arrancar** / **■ Parar**. Em debug injeta
  `-agentlib:jdwp` (`suspend=n`) numa porta própria por serviço — pronto para *attach* do IntelliJ/VS Code.
- **Build**, **Clean build** (`package`), **Clean install** (`install`), **Endpoints**, **Swagger**, **Abrir URL**, **Pasta**.
- Ao fechar a app (Ctrl+C) todos os processos filhos são terminados.

Separadores:

| Separador | O que faz |
|---|---|
| **Logs** | saída em tempo real com filtro, cores por nível, auto-scroll; deteta "Started … in" e a porta real |
| **Endpoints** | cliente REST integrado: lê o OpenAPI do serviço (com seletor de **grupo/API** quando há vários Swaggers), lista operações por tag, preenche path/query params e um body de exemplo gerado do schema, envia pelo servidor (sem CORS), mostra status/tempo/headers/body, copia como `curl`; pedido livre para qualquer método/URL; **token do Keycloak** (realm/client/utilizador/password) anexado como `Bearer` a todos os pedidos de todos os serviços |
| **Swagger** | Swagger UI embebido (ou em nova aba) |
| **Ambientes** | compositor de perfis: a partir de `application-local.yml`, escolhe por variável de que ambiente (`dev`, `sit`, `uat`…) vem o valor e gera `application-<perfil>.yml` na pasta do serviço; interruptor "usar no arranque"; escolhas guardadas por serviço; não substitui ficheiros que não tenha gerado sem confirmar |
| **Dependências** | dependências declaradas nos `pom.xml` (por módulo, versão ou "gerida" pelo parent/BOM, scope, etiquetas Spring Boot/Keycloak/Swagger/BD) e árvore completa resolvida com `mvn dependency:tree` |
| **Git** | branch atual com ↑/↓ face ao remoto, Fetch/Pull/Push; alterações (staged/unstaged/não seguidas) com diff, preparar/despreparar/descartar, commit; criar branch e mudar de branch; histórico. Num monorepo limita-se à pasta do serviço |
| **Configuração** | tudo o que foi detetado (pasta, módulos, porta, datasource, perfis, wrapper, jar) e as definições de arranque: perfil Spring, **porta HTTP de arranque** (`--server.port`), porta de debug, args JVM e Maven, variáveis de ambiente, caminho do Swagger |

### Keycloak

- Arrancar (`kc.bat start-dev --http-port=…` com admin bootstrap), parar, reiniciar, `kc.bat build`, logs.
- **Providers / SPIs**: lista de `providers/`, remover; para cada projeto SPI detetado, **Build & instalar**
  (`mvn package` + copiar o jar) — depois basta reiniciar.
- **Administração** (Admin REST API, sem abrir a consola):
  - **Realms**: criar (vazio, **copiar de um realm existente** ou importar de ficheiro), criar vários de uma vez
    (`local, dev, sit`), ativar/desativar **registo de utilizadores**, exportar para JSON (`keycloak-realms/`
    na pasta raiz — versionável), apagar.
  - **Clients**: criar (público/confidencial, redirect URIs, web origins, direct access grants), apagar.
  - **Utilizadores**: procurar, criar, ativar/desativar, mudar password, apagar.
  - **Providers carregados** (`/admin/serverinfo`): confirmar que o teu SPI foi apanhado.

### Containers (Podman / Docker)

Estado da máquina do Podman (arrancar/parar), containers (iniciar, parar, reiniciar, remover, logs em tempo real),
imagens (listar, remover). Usa os comandos `podman …` do sistema (Definições → comando de containers; `docker`
também funciona), por isso mostra tudo o que o motor conhece.

### Redis

Liga a qualquer Redis (Definições → Redis) ou cria/arranca um container `redis:7-alpine` com um clique.
Estado (versão, chaves, memória, hits/misses), pesquisa de chaves com `SCAN`, valor por tipo (string editável,
hash, list, set, zset, stream), TTL, apagar, nova chave, flush e consola de comandos (bloqueia `SHUTDOWN`,
`MONITOR`, `DEBUG`…).

### Diagnóstico

Verifica na máquina: Node, Java/`JAVA_HOME`, Maven/wrappers, Git, pasta raiz e serviços detetados, portas de cada
serviço (livre / a correr / ocupada por outro processo), Keycloak (pasta, versão, porta), Podman e Redis, com
✓/⚠/✗, dicas de correção e **Copiar relatório**. O primeiro sítio a abrir numa máquina nova.

### Definições

Pasta raiz, Keycloak (pasta, porta, admin), Java/Maven (`JAVA_HOME`, comando `mvn`, preferir wrapper, porta de
debug base), comando de containers, Redis (host, porta, DB, password, container e imagem).

---

## Exemplos incluídos (`examples/`)

Projetos reais para experimentar tudo (ver [examples/README.md](examples/README.md)):

| Projeto | Mostra |
|---|---|
| `product-service` | Spring Boot + Swagger + H2 |
| `order-service` | chama o product-service; perfis `local`/`dev`/`sit`/`uat` |
| `user-service` | resource server OAuth2 (Keycloak); `/api/me` exige token |
| `ms-cliente` | **hexagonal multi-módulo** com dois grupos Swagger |
| `keycloak-event-logger-spi` | SPI: EventListener |
| `keycloak-tipo-utilizador-spi` | SPI: autorização de login por tipo de utilizador e client, com script de configuração do fluxo |
| `web-app` | site com login/registo via Keycloak (keycloak-js, PKCE) |

---

## Desenvolvimento

```bash
npm run dev          # servidor (tsx watch, :3210) + Vite com hot-reload (:5173)
npm run typecheck
npm run build        # dist/client (Vite) + dist/server/index.cjs (esbuild)
npm run scan -- <pasta>   # deteção sem UI
npm run smoke        # teste ponta-a-ponta com test-fixtures (arranca um Spring Boot real)
```

### Estrutura

```
src/shared/types.ts          tipos partilhados servidor ↔ browser
src/server/index.ts          servidor Express (API + ficheiros estáticos), abre o browser
src/server/api.ts            rotas /api (scan, arranque, build, deploy SPI, admin Keycloak, git, redis, …)
src/server/events.ts         Server-Sent Events (logs, estados, scans)
src/server/scanner.ts        deteção de projetos (pom.xml, multi-módulo, application.*)
src/server/processManager.ts spawn, logs, deteção de estado, kill em árvore
src/server/keycloak.ts       kc.bat, providers/, cliente Admin REST, clonagem de realms
src/server/envs.ts           compositor de perfis (application-<ambiente>.yml)
src/server/deps.ts           dependências Maven (pom.xml)
src/server/git.ts            operações git por serviço
src/server/containers.ts     podman/docker: máquina, containers, imagens
src/server/redis.ts          cliente Redis (node-redis)
src/server/diagnostics.ts    verificações da máquina
src/server/fsapi.ts          seletor de pastas, abrir Explorer
src/server/settings.ts       settings.json
src/client/                  UI React (Sidebar, ServiceView e separadores, KeycloakView, ContainersView, RedisView, …)
scripts/                     scan.ts, smoke.ts
test-fixtures/               projetos mínimos usados pelos testes automáticos
examples/                    microserviços de exemplo reais
```

---

## Limitações e notas

- Só projetos **Maven**; Gradle não é detetado.
- O Swagger embebido pode ficar em branco se o serviço enviar `X-Frame-Options` (Spring Security) — usa
  "Abrir em nova aba" ou o separador Endpoints.
- O Keycloak, os microserviços e o Redis escutam em `0.0.0.0`; a app só em `127.0.0.1`.
- Desenvolvido e testado em macOS; os caminhos específicos de Windows (`kc.bat`, `mvnw.cmd`, `taskkill`,
  aspas no `cmd.exe`) estão implementados mas devem ser confirmados no primeiro uso — a página Diagnóstico e a
  primeira linha dos Logs (comando exato) ajudam a localizar qualquer diferença.
