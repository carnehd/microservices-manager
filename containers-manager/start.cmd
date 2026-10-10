@echo off
rem Arranca o Containers Manager (Windows): instala dependências se faltarem, compila e abre o browser.
cd /d "%~dp0"
if not exist node_modules (
  echo A instalar dependencias...
  call npm install || exit /b 1
)
if not exist dist\server\index.cjs (
  echo A compilar...
  call npm run build || exit /b 1
)
node dist\server\index.cjs
