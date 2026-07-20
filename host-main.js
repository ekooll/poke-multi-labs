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

const SIDEBAR_W = 206           // DIP (aberta) — bate com .side no CSS
const SIDEBAR_W_COLLAPSED = 56  // DIP (recolhida) — bate com body.collapsed .side
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
// ---- auth / licenca (Fase 3) ----
let licensedTelas = 1   // quantas telas a licenca libera (1 gratis / 4 pago)
let authEmail = null
let machineId = null

const profilesDir = path.join(os.homedir(), '.poke-multi-labs', 'perfis')
const delay = (ms) => new Promise(r => setTimeout(r, ms))

// log em arquivo (diagnostico do .exe empacotado)
const LOGDIR = path.join(os.homedir(), '.poke-multi-labs')
function dlog (...a) { try { fs.mkdirSync(LOGDIR, { recursive: true }); fs.appendFileSync(path.join(LOGDIR, 'debug.log'), a.join(' ') + '\n') } catch {} }
process.on('uncaughtException', e => dlog('!! uncaughtException ' + e.message + ' | ' + (e.stack || '')))
process.on('unhandledRejection', e => dlog('!! unhandledRejection ' + (e && e.message ? e.message : e)))

// ================= AUTH / LICENCA (via fetch; sem SDK) =================
const SUPA = CFG.SUPABASE_URL
const ANON = CFG.SUPABASE_ANON_KEY
const sessionFile = () => path.join(LOGDIR, 'session.json')
function saveSession (s) { try { fs.mkdirSync(LOGDIR, { recursive: true }); fs.writeFileSync(sessionFile(), JSON.stringify(s)) } catch {} }
function loadSession () { try { return JSON.parse(fs.readFileSync(sessionFile(), 'utf8')) } catch { return null } }
function clearSession () { try { fs.unlinkSync(sessionFile()) } catch {} }

// machine_id estavel = MachineGuid do Windows (nao copiavel junto da pasta)
async function getMachineId () {
  if (machineId) return machineId
  machineId = await new Promise(resolve => {
    try {
      const ps = spawn('powershell', ['-NoProfile', '-Command', "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid"])
      let o = ''; ps.stdout.on('data', d => { o += d })
      ps.on('close', () => resolve(o.trim() || 'unknown'))
      ps.on('error', () => resolve('unknown'))
    } catch { resolve('unknown') }
  })
  return machineId
}

async function supaPost (urlPath, body, token) {
  const headers = { apikey: ANON, 'Content-Type': 'application/json' }
  if (token) headers.Authorization = 'Bearer ' + token
  const r = await fetch(SUPA + urlPath, { method: 'POST', headers, body: JSON.stringify(body) })
  return r.json().catch(() => ({}))
}

async function doSignup (email, password) {
  const d = await supaPost('/auth/v1/signup', { email, password })
  if (d.error_code || (d.msg && !d.id && !d.access_token)) return { error: d.msg || 'erro no cadastro' }
  return { ok: true, needConfirm: !d.access_token }
}
async function doSignin (email, password) {
  const d = await supaPost('/auth/v1/token?grant_type=password', { email, password })
  if (!d.access_token) return { error: d.msg || 'e-mail ou senha invalidos' }
  saveSession({ refresh_token: d.refresh_token, email })
  return { ok: true, access_token: d.access_token, email }
}
async function refreshToken () {
  const s = loadSession(); if (!s || !s.refresh_token) return null
  const d = await supaPost('/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh_token })
  if (!d.access_token) return null
  saveSession({ refresh_token: d.refresh_token, email: s.email })
  return { access_token: d.access_token, email: s.email }
}
async function checkLicense (token) {
  const mid = await getMachineId()
  const d = await supaPost('/rest/v1/rpc/verificar_licenca', { p_machine_id: mid, p_nome: os.hostname() }, token)
  return d
}

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

function clampN (n) { return Math.max(1, Math.min(licensedTelas, CFG.MAX_PANELS, n || 1)) }
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
    const sp = scriptPath('win32.ps1')
    dlog('runWin32 script=' + sp + ' existe=' + fs.existsSync(sp) + ' payloadKeys=' + Object.keys(payload).join(','))
    const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', sp])
    let out = '', err = ''
    ps.stdout.on('data', d => { out += d })
    ps.stderr.on('data', d => { err += d })
    ps.on('error', e => { dlog('!! runWin32 spawn error ' + e.message); resolve(null) })
    ps.on('close', c => { dlog('runWin32 close code=' + c + ' out=' + out.trim() + ' err=' + err.trim().slice(0, 300)); try { resolve(JSON.parse(out.trim())) } catch { resolve(null) } })
    ps.stdin.write(JSON.stringify(payload)); ps.stdin.end()
  })
}

function spawnChrome (profile) {
  const browser = findBrowser()
  dlog('spawnChrome browser=' + browser + ' profile=' + profile)
  if (!browser) { dlog('!! CHROME/EDGE NAO ENCONTRADO'); return }
  try {
    const child = spawn(browser, [
      `--user-data-dir=${profile}`,
      `--app=${CFG.GAME_URL}`,
      '--window-position=-4000,-4000',
      '--window-size=900,600',
      ...CFG.CHROME_FLAGS
    ], { detached: true, stdio: 'ignore' })
    child.on('error', e => dlog('!! chrome spawn error ' + e.message))
    child.unref()
  } catch (e) { dlog('!! spawnChrome throw ' + e.message) }
}

// mata chromes SO deste perfil (conta-N)
// mata chromes SO deste perfil (conta-N) e ESPERA terminar (senao mata o
// chrome novo que acabou de nascer -> race condition -> "0/X encaixadas").
function killProfile (profile) {
  return new Promise(resolve => {
    const leaf = path.basename(profile)
    const cmd = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe'\" | " +
      `Where-Object { $_.CommandLine -like '*${leaf}*' } | ` +
      "ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }"
    try {
      const ps = spawn('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'ignore' })
      ps.on('close', () => resolve())
      ps.on('error', () => resolve())
    } catch { resolve() }
  })
}

// mata TUDO dos nossos perfis (ao fechar o app)
function killAll () {
  const cmd = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*poke-multi-labs*' } | " +
    "ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }"
  try { spawn('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'ignore' }) } catch {}
  slots = []
}

// numero de perfil estavel (conta-1..4): fecha uma no meio e o num fica livre
function lowestFreeNum () {
  const u = new Set(slots.map(s => s.num))
  for (let n = 1; n <= CFG.MAX_PANELS; n++) if (!u.has(n)) return n
  return null
}

// abre UMA conta nova (nao mexe nas ja abertas/logadas)
async function addAccount () {
  if (slots.length >= Math.min(licensedTelas, CFG.MAX_PANELS)) return
  const num = lowestFreeNum(); if (num == null) return
  const profile = path.join(profilesDir, `conta-${num}`)
  const slot = { num, profile, hwnd: null }
  slots.push(slot); pushState()
  await killProfile(profile)      // await = sem race (nao mata o chrome novo)
  await delay(250)
  spawnChrome(profile)
  dlog('addAccount num=' + num)
  const res = await runWin32({ hostHwnd: hostHwndStr(), topPx: topPx(), leftPx: leftPx(), mode: layoutMode, solo: -1, profiles: [profile] })
  if (res && res.hwnds && res.hwnds[0]) slot.hwnd = res.hwnds[0]
  await applyLayout(); pushState()
  dlog('addAccount FIM num=' + num + ' hwnd=' + slot.hwnd)
}

// fecha UMA conta (por indice na lista)
async function closeAccountAt (idx) {
  if (idx < 0 || idx >= slots.length) return
  const [s] = slots.splice(idx, 1)
  await killProfile(s.profile)
  if (solo === idx || solo >= slots.length) solo = -1
  await applyLayout(); pushState()
}

// muda o numero de telas (adiciona/remove sem fechar as demais)
async function setCount (target) {
  if (busy || !win) return
  busy = true
  try {
    target = clampN(target)
    fs.mkdirSync(profilesDir, { recursive: true })
    while (slots.length < target) await addAccount()
    while (slots.length > target) await closeAccountAt(slots.length - 1)
  } catch (e) { dlog('!! setCount ERRO ' + e.message + ' | ' + (e.stack || '')) } finally { busy = false }
}

async function publicAdd () { if (busy || !win) return; busy = true; try { await addAccount() } catch (e) { dlog('!! add ' + e.message) } finally { busy = false } }
async function publicClose (idx) { if (busy || !win) return; busy = true; try { await closeAccountAt(idx) } catch (e) { dlog('!! close ' + e.message) } finally { busy = false } }

function scheduleRelayout () { clearTimeout(relayoutTimer); relayoutTimer = setTimeout(applyLayout, 180) }

async function applyLayout () {
  if (!win) return
  const hs = currentHwnds()
  if (!hs.length) return
  await runWin32({ hostHwnd: hostHwndStr(), topPx: topPx(), leftPx: leftPx(), mode: layoutMode, solo, hwnds: hs })
}

function pushState () {
  if (!win) return
  win.webContents.send('state', {
    count: slots.length, embedded: currentHwnds().length, mode: layoutMode, solo,
    maxTelas: licensedTelas, email: authEmail,
    slots: slots.map((s, i) => ({ i, num: s.num, embedded: !!s.hwnd }))
  })
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

// auto-QA: exercita todos os controles do app e loga erros (env PMLABS_SELFTEST=1)
async function runSelfTest () {
  dlog('===== SELFTEST inicio =====')
  const step = async (name, fn) => {
    try { dlog('SELFTEST > ' + name); await fn(); await delay(2600); dlog('SELFTEST OK ' + name + ' | slots=' + slots.length + ' hwnds=' + JSON.stringify(currentHwnds()) + ' solo=' + solo + ' mode=' + layoutMode) }
    catch (e) { dlog('SELFTEST !!ERRO ' + name + ' :: ' + e.message + ' | ' + (e.stack || '')) }
  }
  await step('setCount(2)', () => setCount(2))
  await step('layout columns', () => { layoutMode = 'columns'; return applyLayout() })
  await step('layout rows', () => { layoutMode = 'rows'; return applyLayout() })
  await step('layout grid', () => { layoutMode = 'grid'; return applyLayout() })
  await step('solo 0', () => { solo = 0; return applyLayout() })
  await step('solo 1', () => { solo = 1; return applyLayout() })
  await step('solo -1 (todas)', () => { solo = -1; return applyLayout() })
  await step('addAccount (3a)', () => publicAdd())
  await step('sidebar recolher', () => { sidebarCollapsed = true; return applyLayout() })
  await step('sidebar expandir', () => { sidebarCollapsed = false; return applyLayout() })
  await step('closeAccountAt(1) (fecha do meio)', () => publicClose(1))
  await step('setCount(1)', () => setCount(1))
  await step('relayout (simula resize)', () => applyLayout())
  dlog('===== SELFTEST fim =====')
}

// depois de logar/restaurar: valida licenca, define telas e abre o painel
async function enterApp (token, email) {
  const lic = await checkLicense(token)
  licensedTelas = (lic && lic.telas) ? lic.telas : 1
  authEmail = email
  dlog('enterApp email=' + email + ' telas=' + licensedTelas + ' lic=' + JSON.stringify(lic))
  win.loadFile(path.join(__dirname, 'renderer', 'host-toolbar.html'))
  win.webContents.once('did-finish-load', async () => {
    await setCount(1); startPopupWatch()
    if (process.env.PMLABS_SELFTEST) runSelfTest()
  })
}

function createWindow () {
  try { fs.mkdirSync(LOGDIR, { recursive: true }); fs.writeFileSync(path.join(LOGDIR, 'debug.log'), '=== boot __dirname=' + __dirname + ' | browser=' + findBrowser() + '\n') } catch {}
  win = new BrowserWindow({
    width: 1500, height: 900, backgroundColor: '#0a0605', title: 'Vperts Multi',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'renderer', 'logo-vp.png'),
    webPreferences: { preload: path.join(__dirname, 'host-preload.js'), contextIsolation: true, nodeIntegration: false }
  })
  win.setMenuBarVisibility(false)
  win.on('resize', () => scheduleRelayout())
  win.on('closed', () => { win = null; stopPopupWatch(); killAll() })

  // boot: restaura sessao salva -> entra direto; senao mostra login
  refreshToken()
    .then(sess => { if (sess) enterApp(sess.access_token, sess.email); else win.loadFile(path.join(__dirname, 'renderer', 'login.html')) })
    .catch(() => win.loadFile(path.join(__dirname, 'renderer', 'login.html')))
}

// IPC
ipcMain.handle('relaunch', async (_e, n) => { await setCount(n); return slots.length })
ipcMain.handle('add-account', async () => { await publicAdd(); return slots.length })
ipcMain.handle('close-account', async (_e, idx) => { await publicClose(idx); return slots.length })
ipcMain.on('set-layout', (_e, m) => { if (['grid', 'columns', 'rows'].includes(m)) { layoutMode = m; applyLayout() } })
ipcMain.on('set-solo', (_e, idx) => { solo = (idx == null ? -1 : idx); applyLayout() })
ipcMain.on('set-sidebar', (_e, collapsed) => { sidebarCollapsed = !!collapsed; applyLayout() })
ipcMain.handle('get-state', () => ({ count: slots.length, embedded: currentHwnds().length, mode: layoutMode, solo, maxTelas: licensedTelas, email: authEmail }))

// --- auth ---
ipcMain.handle('login', async (_e, email, password) => {
  const r = await doSignin(email, password)
  if (r.ok) { await enterApp(r.access_token, r.email) }
  return r
})
ipcMain.handle('signup', async (_e, email, password) => doSignup(email, password))
ipcMain.handle('logout', async () => {
  clearSession(); licensedTelas = 1; authEmail = null
  stopPopupWatch(); killAll()
  win.loadFile(path.join(__dirname, 'renderer', 'login.html'))
  return true
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { killAll(); if (process.platform !== 'darwin') app.quit() })
