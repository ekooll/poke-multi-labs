@echo off
REM Abre o Chrome no MESMO perfil que o Vperts Multi usa pra Conta 3.
REM Instale aqui: Tampermonkey + (Detalhes) "Permitir user scripts" + o userscript v6.
REM Depois feche este Chrome e reabra o app -> a Conta 3 tera o bridge.
setlocal
set "CH=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CH%" set "CH=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
start "" "%CH%" --user-data-dir="%USERPROFILE%\.poke-multi-labs\perfis\conta-3"
