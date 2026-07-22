@echo off
REM Abre o Chrome no MESMO perfil que o Vperts Multi usa pra Conta 4.
REM Use isto pra instalar o Tampermonkey + o bridge nesse perfil (uma vez).
REM Depois feche este Chrome e reabra o app -> a Conta 4 tera o bridge.
setlocal
set "CH=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CH%" set "CH=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
start "" "%CH%" --user-data-dir="%USERPROFILE%\.poke-multi-labs\perfis\conta-4"
