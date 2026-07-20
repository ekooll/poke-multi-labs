// ============================================================
// Poke Multi-Labs — HOST (motor final, incremental)
// Lanca ate 4 Chromes REAIS (Google funciona) e os ENCAIXA numa
// unica janela via reparent Win32. Sidebar: nº de telas, layout
// (grade/horizontal/vertical), foco (solo). Adicionar/remover telas
// e INCREMENTAL: nao fecha as que ja estao abertas/logadas.
//   npm run host   (ou: electron host-main.js [1..4])
// ============================================================

const { app, BrowserWindow, ipcMain, screen } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const CFG = require('./config.js')

const SIDEBAR_W = 184           // DIP (aberta)
const SIDEBAR_W_COLLAPSED = 34  // DIP (recolhida = so o botao de expandir)
const TOP_H = 0
let sidebarCollapsed = false

let win = null
let slots = []               // [{ profile, hwnd(str|null) }] em ordem conta-1..N
let layoutMode = 'grid'      // 'grid' | 'columns' | 'rows'
let solo = -1
let relayoutTimer = null
let seenPopups = []
let popupTimer = null
let busy = false

const profilesDir = path.join(os.homedir(), '.poke-multi-labs', 'perfis')
const delay = (ms) => new Promise(r => setTimeout(r, ms))

function findBrowser () {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files'
  const pfx = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const la = process.env['LOCALAPPDATA'] || ''
  return [
    path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pfx, 'Google\\Chrome\\Application\\chrome.exe'),
    la && path.join(la, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pfx, 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe')
  ].filter(Boolean).find(p => fs.existsSync(p))
}

function clampN (n) { return Math.max(1, Math.min(CFG.MAX_PANELS, n || 1)) }
function scale () { return screen.getPrimaryDisplay().scaleFactor || 1 }
function leftPx () { return Math.round((sidebarCollapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W) * scale()) }
function topPx () { return Math.round(TOP_H * scale()) }
function hostHwndStr () {
  const buf = win.getNativeWindowHandle()
  return buf.length === 8 ? buf.readBigUInt64LE().toString() : String(buf.readUInt32LE())
}
function currentHwnds () { return slots.map(s => s.hwnd).filter(Boolean) }
// no .exe empacotado os .ps1 ficam em app.asar.unpacked (o PowerShell nao le de dentro do asar)
function scriptPath (name) { return path.join(__dirname, name).replace('app.asar', 'app.asar.unpacked') }

function runWin32 (payload) {
  return new Promise((resolve) => {
    const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('win32.ps1')])
    let out = ''
    ps.stdout.on('data', d => { out += d })
    ps.stderr.on('data', d => console.log('[win32]', d.toString().trim()))
    ps.on('close', () => { try { resolve(JSON.parse(out.trim())) } catch { resolve(null) } })
    ps.stdin.write(JSON.stringify(payload)); ps.stdin.end()
  })
}

function spawnChrome (profile) {
  const browser = findBrowser()
  if (!browser) { console.error('Chrome/Edge nao encontrado'); return }
  const child = spawn(browser, [
    `--user-data-dir=${profile}`,
    `--app=${CFG.GAME_URL}`,
    '--window-position=-4000,-4000',
    '--window-size=900,600',
    ...CFG.CHROME_FLAGS
  ], { detached: true, stdio: 'ignore' })
  child.unref()
}

// mata chromes SO deste perfil (conta-N)
function killProfile (profile) {
  const leaf = path.basename(profile)
  const cmd = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe'\" | " +
    `Where-Object { $_.CommandLine -like '*${leaf}*' } | ` +
    "ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }"
  try { spawn('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'ignore' }) } catch {}
}

// mata TUDO dos nossos perfis (ao fechar o app)
function killAll () {
  const cmd = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*poke-multi-labs*' } | " +
    "ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }"
  try { spawn('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'ignore' }) } catch {}
  slots = []
}

// muda o numero de telas SEM fechar as que ja estao abertas
async function setCount (target) {
  if (busy || !win) return
  busy = true
  try {
    target = clampN(target)
    fs.mkdirSync(profilesDir, { recursive: true })

    if (target > slots.length) {
      const newProfiles = []
      for (let i = slots.length; i < target; i++) {
        const profile = path.join(profilesDir, `conta-${i + 1}`)
        slots.push({ profile, hwnd: null })
        newProfiles.push(profile)
        killProfile(profile)       // evita handoff se sobrou chrome desse perfil
        await delay(250)
        spawnChrome(profile)
        pushState()
        if (i < target - 1) await delay(1500)   // escalonado (alivia o pico)
      }
      // descobre + encaixa SO os novos (os antigos ja sao filhos do host)
      const res = await runWin32({ hostHwnd: hostHwndStr(), topPx: topPx(), leftPx: leftPx(), mode: layoutMode, solo: -1, profiles: newProfiles })
      if (res && res.hwnds) {
        let k = 0
        for (const s of slots) { if (s.hwnd == null) s.hwnd = res.hwnds[k++] || null }
      }
    } else if (target < slots.length) {
      const removed = slots.splice(target)
      removed.forEach(s => killProfile(s.profile))
    }

    if (solo >= slots.length) solo = -1
    await applyLayout()
    pushState()
  } finally { busy = false }
}

function scheduleRelayout () { clearTimeout(relayoutTimer); relayoutTimer = setTimeout(applyLayout, 180) }

async function applyLayout () {
  if (!win) return
  const hs = currentHwnds()
  if (!hs.length) return
  await runWin32({ hostHwnd: hostHwndStr(), topPx: topPx(), leftPx: leftPx(), mode: layoutMode, solo, hwnds: hs })
}

function pushState () {
  if (win) win.webContents.send('state', { count: slots.length, embedded: currentHwnds().length, mode: layoutMode, solo })
}

// ---- vigia de popups (login Google): traz pra frente + centraliza ----
async function pollPopups () {
  if (!win || slots.length === 0) return
  const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('popupwatch.ps1')])
  let out = ''
  ps.stdout.on('data', d => { out += d })
  ps.on('close', () => { try { const r = JSON.parse(out.trim()); if (r && r.popups) seenPopups = r.popups } catch {} })
  ps.on('error', () => {})
  ps.stdin.write(JSON.stringify({ known: seenPopups })); ps.stdin.end()
}
function startPopupWatch () { if (!popupTimer) popupTimer = setInterval(pollPopups, 1800) }
function stopPopupWatch () { clearInterval(popupTimer); popupTimer = null }

function createWindow () {
  win = new BrowserWindow({
    width: 1500, height: 900, backgroundColor: '#0a0605', title: 'Poke Multi-Labs',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'host-preload.js'), contextIsolation: true, nodeIntegration: false }
  })
  win.setMenuBarVisibility(false)
  win.loadFile(path.join(__dirname, 'renderer', 'host-toolbar.html'))
  win.on('resize', () => scheduleRelayout())
  win.on('closed', () => { win = null; stopPopupWatch(); killAll() })

  const n = clampN(parseInt(process.argv[2], 10) || CFG.START_PANELS)
  win.webContents.once('did-finish-load', () => { setCount(n); startPopupWatch() })
}

// IPC
ipcMain.handle('relaunch', async (_e, n) => { await setCount(n); return slots.length })
ipcMain.on('set-layout', (_e, m) => { if (['grid', 'columns', 'rows'].includes(m)) { layoutMode = m; applyLayout() } })
ipcMain.on('set-solo', (_e, idx) => { solo = (idx == null ? -1 : idx); applyLayout() })
ipcMain.on('set-sidebar', (_e, collapsed) => { sidebarCollapsed = !!collapsed; applyLayout() })
ipcMain.handle('get-state', () => ({ count: slots.length, embedded: currentHwnds().length, mode: layoutMode, solo }))

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { killAll(); if (process.platform !== 'darwin') app.quit() })
