@echo off
rem Arranque no Windows: instala dependências e compila na primeira vez, depois abre o browser.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js nao encontrado. Instala a partir de https://nodejs.org & pause & exit /b 1)
if not exist node_modules (call npm install || exit /b 1)
if not exist dist\server\index.cjs (call npm run build || exit /b 1)
node dist\server\index.cjs %*
