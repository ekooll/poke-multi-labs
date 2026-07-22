@echo off
REM Abre o Vperts Multi LEVE (migrado, Electron embutido) — main-lite.js
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" main-lite.js
