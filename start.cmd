@echo off
rem Arranque no Windows: instala dependencias (se preciso), COMPILA SEMPRE e abre o browser.
rem Compilar sempre garante que apos um "git pull" corre a versao nova (o dist/ nao vem no git).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js nao encontrado. Instala a partir de https://nodejs.org & pause & exit /b 1)
if not exist node_modules (call npm install || exit /b 1)
call npm run build || exit /b 1
node dist\server\index.cjs %*
