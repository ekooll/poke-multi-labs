@echo off
REM Abre o Chrome no perfil de UMA conta do Vperts Multi (pergunta qual).
REM Use pra instalar o Tampermonkey + bridge no perfil daquela conta.
setlocal
set /p N=Qual conta (1, 2, 3, 4...)?
set "CH=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CH%" set "CH=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
start "" "%CH%" --user-data-dir="%USERPROFILE%\.poke-multi-labs\perfis\conta-%N%"
