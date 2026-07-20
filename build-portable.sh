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
cp host-main.js host-preload.js config.js win32.ps1 popupwatch.ps1 "$STAGE/resources/app/"
cp renderer/host-toolbar.html "$STAGE/resources/app/renderer/"
cp renderer/login.html "$STAGE/resources/app/renderer/"
cp renderer/logo-vp.png "$STAGE/resources/app/renderer/"

cat > "$STAGE/resources/app/package.json" <<'JSON'
{ "name": "poke-multi-labs", "version": "0.2.0", "main": "host-main.js" }
JSON

echo ">> gerando zip"
cd dist
powershell -NoProfile -Command "Compress-Archive -Path 'PokeMultiLabs-Test\*' -DestinationPath 'PokeMultiLabs-Test.zip' -Force"

echo ">> PRONTO"
ls -lah PokeMultiLabs-Test.zip
