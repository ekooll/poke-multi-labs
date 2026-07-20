#!/usr/bin/env bash
# Monta uma distribuicao PORTATIL que roda pelo Electron ASSINADO (passa no SAC
# sem certificado). NAO usa electron-builder (que edita o exe e perde a assinatura).
set -e
cd "$(dirname "$0")"

STAGE="dist/PokeMultiLabs-Test"
echo ">> limpando $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE/resources/app/renderer"

echo ">> copiando runtime do Electron (assinado)"
cp -r node_modules/electron/dist/* "$STAGE/"

echo ">> renomeando electron.exe -> Vperts Multi.exe (hash/assinatura permanece)"
mv "$STAGE/electron.exe" "$STAGE/Vperts Multi.exe"

echo ">> copiando nossos arquivos pra resources/app"
cp host-main.js host-preload.js config.js cdp.js win32.ps1 popupwatch.ps1 focuswatch.ps1 "$STAGE/resources/app/"
cp renderer/host-toolbar.html "$STAGE/resources/app/renderer/"
cp renderer/login.html "$STAGE/resources/app/renderer/"
cp renderer/loot.html "$STAGE/resources/app/renderer/"
cp renderer/curtain.html "$STAGE/resources/app/renderer/"
cp renderer/logo-vp.png "$STAGE/resources/app/renderer/"
[ -f renderer/logo-vp.ico ] && cp renderer/logo-vp.ico "$STAGE/resources/app/renderer/"

echo ">> copiando o modulo 'ws' (pure-JS, pro leitor de loot via CDP)"
mkdir -p "$STAGE/resources/app/node_modules"
cp -r node_modules/ws "$STAGE/resources/app/node_modules/ws"

cat > "$STAGE/resources/app/package.json" <<'JSON'
{ "name": "poke-multi-labs", "version": "0.4.2", "main": "host-main.js" }
JSON

echo ">> criando o .bat de atalho (self-locating; vai junto no zip, ao lado do exe)"
cat > "$STAGE/Criar atalho na Area de Trabalho.bat" <<'BAT'
@echo off
rem Cria um atalho do Vperts Multi na Area de Trabalho apontando pro exe DESTA pasta.
set "EXE=%~dp0Vperts Multi.exe"
set "ICO=%~dp0resources\app\renderer\logo-vp.ico"
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath('Desktop'),'Vperts Multi.lnk'));$s.TargetPath=$env:EXE;$s.WorkingDirectory=(Split-Path $env:EXE);if(Test-Path $env:ICO){$s.IconLocation=$env:ICO};$s.Save()"
echo.
echo Atalho "Vperts Multi" criado na sua Area de Trabalho!
timeout /t 2 >nul
BAT

echo ">> gerando zip"
cd dist
powershell -NoProfile -Command "Compress-Archive -Path 'PokeMultiLabs-Test\*' -DestinationPath 'PokeMultiLabs-Test.zip' -Force"

echo ">> gerando app-update.zip (pro botao Atualizar — so a pasta do app, com node_modules)"
powershell -NoProfile -Command "Compress-Archive -Path 'PokeMultiLabs-Test\resources\app\*' -DestinationPath 'app-update.zip' -Force"

echo ">> PRONTO"
ls -lah PokeMultiLabs-Test.zip app-update.zip
