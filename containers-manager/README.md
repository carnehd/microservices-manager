# Containers Manager

Gestor local, no browser, de containers **podman** (ou docker): containers, imagens, volumes, redes, logs em tempo real, shell dentro dos containers, eventos do motor e podman machine. App independente do Microservices Manager (só partilha a ideia e o estilo).

## Arrancar

```
npm install
npm run build
npm start          # http://localhost:3310 (porta: CM_PORT=4000 npm start)
```

Windows: `start.cmd` faz tudo isto. Desenvolvimento: `npm run dev` (Vite em 5173 com proxy para a API).

## O que faz

- **Containers**: lista com estado, imagem, portas, CPU/mem (stats), health; filtro, só a correr, por projeto (labels compose); seleção múltipla com start/stop/restart/remove; por container: Logs, Shell, restart, stop, start, remove, pause/kill, copiar ficheiros (`cp`), commit para imagem, export `.tar`; "remover parados".
- **Detalhe**: Logs (follow, filtro/regex, níveis ERROR/WARN/INFO, desde, pausa, wrap, download), Shell (comando a comando com `exec … sh -c`, user/dir, histórico ↑/↓, snippets), Inspect (geral, rede, mounts, healthcheck, labels, JSON), Stats (gráfico CPU), Env.
- **Images**: pull com progresso por camada, build por Dockerfile, load/save `.tar` (para PCs com registo bloqueado), tag, camadas (history), remover (bloqueado se em uso), prune dangling.
- **Novo container**: formulário (imagem, nome, detached/rm/restart/rede, portas com deteção de conflito, env vars com import `.env`, volumes, comando, labels, healthcheck, limites, args extra) com o `podman run` gerado em tempo real; modelos (Postgres, Redis, Keycloak dev, Pub/Sub, jar Spring Boot) e "guardar como modelo".
- **Volumes / Networks**: listar, criar, remover, prune; ligar/desligar containers a redes.
- **Events**: `podman events` em tempo real.
- **Machine**: podman machine start/stop/restart (com dica para o "ssh handshake failed"), versões, `system df`, prune, consola de comandos de leitura.
- **Settings**: comando (podman/docker), proxy HTTP(S)/NO_PROXY (usado nos comandos; a machine apanha-o no próximo start), auto-refresh, tail dos logs, tema.
- **Terminal** em baixo com todos os comandos corridos (a verde) e resultado.

Definições em `%APPDATA%\containers-manager` (Windows) ou `~/.config/containers-manager`.
