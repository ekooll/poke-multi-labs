// ============================================================
// Poke Multi-Labs — LANÇADOR (motor novo)
// Abre N instancias do CHROME DE VERDADE, cada uma com perfil
// isolado (--user-data-dir) e em modo app, organizadas em GRADE.
//
// Por que Chrome real e nao webview embutido:
//   o Google BLOQUEIA login OAuth em navegador embutido (Electron/CEF),
//   mas ACEITA no Chrome de verdade. Aqui cada janela e Chrome mesmo,
//   entao "Continuar com o Google" funciona normal. Zero spoof.
//
// Uso:  node launcher.js [numero_de_contas]
//       (padrao = CFG.START_PANELS)
// ============================================================

const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const CFG = require('./config.js')

// teto oficial de 4 contas/IP do Poke Idle World
const N = Math.max(1, Math.min(CFG.MAX_PANELS, parseInt(process.argv[2], 10) || CFG.START_PANELS))
const URL = CFG.GAME_URL

// 1) acha o Chrome (ou Edge, que tambem e Chromium e aceita Google)
function findBrowser () {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files'
  const pfx = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const la = process.env['LOCALAPPDATA'] || ''
  const candidates = [
    path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pfx, 'Google\\Chrome\\Application\\chrome.exe'),
    la && path.join(la, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pfx, 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe')
  ].filter(Boolean)
  return candidates.find(p => fs.existsSync(p))
}

// 2) area util da tela (ja exclui a barra de tarefas)
function screenWorkArea () {
  try {
    const cmd = 'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; ' +
      '$w=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; ' +
      'Write-Output ($w.Width.ToString()+\'x\'+$w.Height.ToString())"'
    const out = execSync(cmd, { encoding: 'utf8' }).trim()
    const [w, h] = out.split('x').map(Number)
    if (w && h) return { w, h }
  } catch {}
  return { w: 1920, h: 1040 } // fallback
}

const browser = findBrowser()
if (!browser) {
  console.error('❌ Chrome/Edge nao encontrado. Instale o Chrome ou ajuste o caminho.')
  process.exit(1)
}

const { w: SW, h: SH } = screenWorkArea()
const cols = Math.ceil(Math.sqrt(N))
const rows = Math.ceil(N / cols)
const cw = Math.floor(SW / cols)
const ch = Math.floor(SH / rows)

const profilesDir = path.join(os.homedir(), '.poke-multi-labs', 'perfis')
fs.mkdirSync(profilesDir, { recursive: true })

console.log(`Navegador : ${browser}`)
console.log(`Tela      : ${SW}x${SH}  ->  grade ${cols}x${rows}  celula ${cw}x${ch}`)
console.log(`Perfis em : ${profilesDir}`)
console.log('')

for (let i = 0; i < N; i++) {
  const cx = i % cols
  const cy = Math.floor(i / cols)
  const x = cx * cw
  const y = cy * ch
  const profile = path.join(profilesDir, `conta-${i + 1}`)
  const args = [
    `--user-data-dir=${profile}`,      // <- ISOLAMENTO: cookies/login proprios por conta
    `--app=${URL}`,                    // <- modo app: so o jogo, sem barra do Chrome
    `--window-position=${x},${y}`,
    `--window-size=${cw},${ch}`,
    ...CFG.CHROME_FLAGS
  ]
  const child = spawn(browser, args, { detached: true, stdio: 'ignore' })
  child.unref()
  console.log(`Conta ${i + 1}: pos(${x},${y}) size ${cw}x${ch}`)
}

console.log('\n✅ Janelas abrindo em grade. Cada uma e Chrome de verdade —')
console.log('   "Continuar com o Google" funciona normal. Loga uma vez por conta;')
console.log('   o perfil guarda a sessao pra proxima.')
