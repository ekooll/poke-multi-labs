// ============================================================
// Poke Multi-Labs — HOST (motor final, incremental)
// Lanca ate 4 Chromes REAIS (Google funciona) e os ENCAIXA numa
// unica janela via reparent Win32. Sidebar: nº de telas, layout
// (grade/horizontal/vertical), foco (solo). Adicionar/remover telas
// e INCREMENTAL: nao fecha as que ja estao abertas/logadas.
//   npm run host   (ou: electron host-main.js [1..4])
// ============================================================

const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const CFG = require('./config.js')
const cdp = require('./cdp.js')

// porta de debug (CDP) unica por conta -> le loot/saldo do jogo
const DEBUG_PORT_BASE = 9333
// auto-update: baixa SO os arquivos do app (uns ~100KB) do GitHub, sem rebaixar o Electron
const REPO_RAW = 'https://raw.githubusercontent.com/ekooll/poke-multi-labs/main'
// zip so com a pasta do app (sem o Electron) — traz ate modulos novos (ex: ws) no update
const UPDATE_ZIP_URL = 'https://github.com/ekooll/poke-multi-labs/releases/latest/download/app-update.zip'
// fonte da VERSAO publicada = a propria release (mesma fonte do zip -> nunca descasa do que sera baixado)
const RELEASES_API = 'https://api.github.com/repos/ekooll/poke-multi-labs/releases/latest'
const APP_FILES = ['host-main.js', 'host-preload.js', 'config.js', 'cdp.js', 'win32.ps1', 'popupwatch.ps1', 'focuswatch.ps1', 'renderer/host-toolbar.html', 'renderer/login.html', 'renderer/loot.html', 'renderer/curtain.html']

const SIDEBAR_W = 206           // DIP (aberta) — bate com .side no CSS
const SIDEBAR_W_COLLAPSED = 56  // DIP (recolhida) — bate com body.collapsed .side
const TOP_H = 0
let sidebarCollapsed = false

let win = null
let lootWin = null           // janela flutuante do Hunt Analyzer (soma de loot)
let overlayWin = null        // "cortina" de transicao (cobre a area do jogo no fade)
let slots = []               // [{ profile, hwnd(str|null) }] em ordem conta-1..N
let layoutMode = 'grid'      // 'grid' | 'columns' | 'rows'
let solo = -1
let relayoutTimer = null
let popupProc = null
let busy = false
// ---- auth / licenca (Fase 3) ----
let licensedTelas = 1   // quantas telas a licenca libera (1 gratis / 4 pago)
let authEmail = null
let authToken = null    // access_token atual (pra chamar RPCs do sorteio)
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
// chama um RPC autenticado; se o token expirou, faz refresh e tenta 1x
async function callRpc (fn, body) {
  if (!authToken) { const s = await refreshToken(); if (s) authToken = s.access_token }
  let d = await supaPost('/rest/v1/rpc/' + fn, body || {}, authToken)
  const expirou = d && (d.code === 'PGRST301' || (typeof d.message === 'string' && /jwt|expired|token/i.test(d.message)))
  if (expirou) { const s = await refreshToken(); if (s) { authToken = s.access_token; d = await supaPost('/rest/v1/rpc/' + fn, body || {}, authToken) } }
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
// arquivo lido pelo focuswatch.ps1 (foco ao clicar): host + paineis atuais
const hwndsFile = () => path.join(LOGDIR, 'hwnds.json')
function writeHwnds () {
  try {
    if (!win) return
    const active = (solo >= 0 && slots[solo]) ? slots[solo].hwnd : (currentHwnds()[0] || null)
    fs.writeFileSync(hwndsFile(), JSON.stringify({ host: hostHwndStr(), hwnds: currentHwnds(), active }))
  } catch {}
}
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

// ---- servidor win32 persistente: compila o Add-Type 1x e atende comandos em ~5ms
// (antes cada troca gastava ~750-1100ms recompilando -> era o "delay/lag" das trocas)
let win32proc = null
let win32outbuf = ''
const win32waiters = []
function startWin32Server () {
  if (win32proc) return
  try {
    win32proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('win32.ps1'), '-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
    win32proc.stdout.setEncoding('utf8')
    win32proc.stdout.on('data', d => {
      win32outbuf += d
      let idx
      while ((idx = win32outbuf.indexOf('\n')) >= 0) {
        const line = win32outbuf.slice(0, idx).trim()
        win32outbuf = win32outbuf.slice(idx + 1)
        if (!line) continue
        const w = win32waiters.shift()
        if (w) { try { w(JSON.parse(line)) } catch { w(null) } }
      }
    })
    win32proc.on('exit', () => { win32proc = null; while (win32waiters.length) win32waiters.shift()(null) })
    win32proc.on('error', e => { dlog('!! win32 server ' + e.message); win32proc = null })
    dlog('win32 server iniciado')
  } catch (e) { dlog('!! startWin32Server ' + e.message) }
}
function stopWin32Server () { try { if (win32proc) { win32proc.stdin.end(); win32proc.kill() } } catch {} win32proc = null }

// envia comando ao server e espera 1 linha JSON. Serializa (1 por vez, FIFO).
// Cai no runWin32 avulso se o server nao estiver de pe.
let win32chain = Promise.resolve()
function win32cmd (payload) {
  const run = () => new Promise(resolve => {
    if (!win32proc || !win32proc.stdin.writable) { runWin32(payload).then(resolve); return }
    win32waiters.push(resolve)
    try { win32proc.stdin.write(JSON.stringify(payload) + '\n') }
    catch (e) { win32waiters.pop(); runWin32(payload).then(resolve) }
  })
  const p = win32chain.then(run, run)
  win32chain = p.then(() => {}, () => {})
  return p
}

function spawnChrome (profile, port) {
  const browser = findBrowser()
  dlog('spawnChrome browser=' + browser + ' profile=' + profile + ' port=' + port)
  if (!browser) { dlog('!! CHROME/EDGE NAO ENCONTRADO'); return }
  try {
    const dbg = port ? [`--remote-debugging-port=${port}`, '--remote-allow-origins=*'] : []
    const child = spawn(browser, [
      `--user-data-dir=${profile}`,
      `--app=${CFG.GAME_URL}`,
      '--window-position=-4000,-4000',
      '--window-size=900,600',
      ...dbg,
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
  const port = DEBUG_PORT_BASE + num
  const slot = { num, profile, port, hwnd: null }
  slots.push(slot); pushState()
  await killProfile(profile)      // await = sem race (nao mata o chrome novo)
  await delay(250)
  spawnChrome(profile, port)
  dlog('addAccount num=' + num)
  const res = await win32cmd({ hostHwnd: hostHwndStr(), topPx: topPx(), leftPx: leftPx(), mode: layoutMode, solo: -1, profiles: [profile] })
  if (res && res.hwnds && res.hwnds[0]) slot.hwnd = res.hwnds[0]
  // se estava em modo FOCO (solo), mostra a conta recem-aberta (senao o layout
  // reaplicava o solo antigo e "voltava" pra conta anterior -> efeito "pisca").
  if (solo >= 0) solo = slots.indexOf(slot)
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
    await withCurtain(async () => {
      while (slots.length < target) await addAccount()
      while (slots.length > target) await closeAccountAt(slots.length - 1)
      const s = slots[slots.length - 1]
      if (s && s.port && slots.length) await cdp.waitReady(s.port, 3500)
    }, { inMs: 60, outMs: 160 })
  } catch (e) { dlog('!! setCount ERRO ' + e.message + ' | ' + (e.stack || '')) } finally { busy = false }
}

async function publicAdd () {
  if (busy || !win) return; busy = true
  try {
    await withCurtain(async () => {
      await addAccount()
      const s = slots[slots.length - 1]                 // conta recem-aberta
      if (s && s.port) await cdp.waitReady(s.port, 3500) // segura a cortina ate o jogo pintar (sem flash branco)
    }, { inMs: 60, outMs: 160 })
  } catch (e) { dlog('!! add ' + e.message) } finally { busy = false }
}
async function publicClose (idx) {
  if (busy || !win) return; busy = true
  try { await withCurtain(() => closeAccountAt(idx), { inMs: 0, outMs: 120 }) } catch (e) { dlog('!! close ' + e.message) } finally { busy = false }
}

// ---- atalhos globais (funcionam mesmo com o foco dentro do Chrome encaixado) ----
// Ctrl+1..4 = foca a conta pelo NUMERO (nao pelo indice) · Ctrl+0 = todas · F11 = tela cheia
function focusByNum (n) {
  if (!win) return
  let target
  if (n === 0) target = -1
  else { const idx = slots.findIndex(s => s.num === n); if (idx < 0) return; target = idx }
  withCurtain(() => { solo = target; return applyLayout() }, { inMs: 0, outMs: 110 }).then(() => pushState())
}
function registerShortcuts () {
  try {
    for (let n = 1; n <= CFG.MAX_PANELS; n++) globalShortcut.register('CommandOrControl+' + n, () => focusByNum(n))
    globalShortcut.register('CommandOrControl+0', () => focusByNum(0))
    globalShortcut.register('F11', () => { if (win) win.setFullScreen(!win.isFullScreen()) })
    dlog('atalhos registrados')
  } catch (e) { dlog('!! registerShortcuts ' + e.message) }
}
function unregisterShortcuts () { try { globalShortcut.unregisterAll() } catch {} }

// ================= TRANSICOES SUAVES (cortina + fade) =================
// Um overlay tematico cobre a AREA DO JOGO durante a troca/abertura e some com
// fade, revelando o layout ja assentado. Nao toca no render do Chrome (a cortina
// e uma janela nossa por cima). setOpacity anima o fade.
function ensureOverlay () {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin
  overlayWin = new BrowserWindow({
    parent: win, frame: false, resizable: false, movable: false, skipTaskbar: true,
    focusable: false, show: false, hasShadow: false, alwaysOnTop: true, backgroundColor: '#0a0605',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  overlayWin.setAlwaysOnTop(true, 'screen-saver')
  overlayWin.setIgnoreMouseEvents(true)
  overlayWin.loadFile(path.join(__dirname, 'renderer', 'curtain.html'))
  overlayWin.on('closed', () => { overlayWin = null })
  return overlayWin
}
function positionOverlay () {
  if (!win || !overlayWin) return
  const b = win.getContentBounds()
  const left = sidebarCollapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W
  overlayWin.setBounds({ x: b.x + left, y: b.y + TOP_H, width: Math.max(1, b.width - left), height: Math.max(1, b.height - TOP_H) })
}
function fadeWin (w, from, to, ms) {
  return new Promise(resolve => {
    const steps = Math.max(1, Math.round(ms / 16))
    let i = 0
    try { w.setOpacity(from) } catch {}
    const t = setInterval(() => {
      i++
      const v = from + (to - from) * (i / steps)
      try { w.setOpacity(v) } catch {}
      if (i >= steps) { clearInterval(t); resolve() }
    }, 16)
  })
}
// mostra a cortina (fade-in rapido), roda fn (reparent/layout) atras, some com fade
let curtainBusy = false
async function withCurtain (fn, opts) {
  if (!win || curtainBusy) return fn()   // transicao ja rolando -> faz direto (sem sobrepor cortinas)
  curtainBusy = true
  const ov = ensureOverlay()
  const o = opts || {}
  try {
    positionOverlay()
    try { ov.setOpacity(0); ov.showInactive() } catch {}
    await fadeWin(ov, 0, 1, o.inMs != null ? o.inMs : 90)
    await fn()
    positionOverlay()
    await fadeWin(ov, 1, 0, o.outMs != null ? o.outMs : 240)
  } catch (e) { dlog('!! withCurtain ' + e.message); try { await fn() } catch {} }
  finally { try { ov.hide(); ov.setOpacity(1) } catch {} curtainBusy = false }
}

function scheduleRelayout () { clearTimeout(relayoutTimer); relayoutTimer = setTimeout(applyLayout, 180) }

// quando o app volta do alt-tab, o Chrome encaixado perde a ativacao e o menu do
// jogo fica "morto". Aqui devolvemos o foco a janela visivel (sem reparent = sem flicker).
let refocusTimer = null
function refocusVisible () {
  if (!win || !slots.length) return
  const hwnd = (solo >= 0 && slots[solo]) ? slots[solo].hwnd : currentHwnds()[0]
  if (!hwnd) return
  win32cmd({ refocus: true, hostHwnd: hostHwndStr(), focusHwnd: hwnd })
}
function scheduleRefocus () { clearTimeout(refocusTimer); refocusTimer = setTimeout(refocusVisible, 130) }

async function applyLayout () {
  if (!win) return
  const hs = currentHwnds()
  if (!hs.length) { writeHwnds(); return }
  await win32cmd({ hostHwnd: hostHwndStr(), topPx: topPx(), leftPx: leftPx(), mode: layoutMode, solo, hwnds: hs })
  writeHwnds()   // atualiza a lista pro vigia de foco-ao-clicar
}

function pushState () {
  if (!win) return
  win.webContents.send('state', {
    count: slots.length, embedded: currentHwnds().length, mode: layoutMode, solo,
    maxTelas: licensedTelas, email: authEmail,
    slots: slots.map((s, i) => ({ i, num: s.num, embedded: !!s.hwnd }))
  })
}

// ---- vigia de popups (login Google) PERSISTENTE: traz pra frente + centraliza ----
// (antes spawnava a cada 1.8s recompilando o Add-Type = pico de CPU no fundo)
function startPopupWatch () {
  if (popupProc) return
  try {
    popupProc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('popupwatch.ps1')], { stdio: 'ignore' })
    popupProc.on('exit', () => { popupProc = null })
    popupProc.on('error', e => { dlog('!! popupwatch ' + e.message); popupProc = null })
  } catch (e) { dlog('!! startPopupWatch ' + e.message) }
}
function stopPopupWatch () { try { popupProc && popupProc.kill() } catch {} popupProc = null }

// ---- vigia de FOCO AO CLICAR (foco de teclado no painel clicado) ----
let focusWatcher = null
function startFocusWatch () {
  if (focusWatcher) return
  try {
    writeHwnds()
    focusWatcher = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('focuswatch.ps1'), hwndsFile()], { stdio: 'ignore' })
    focusWatcher.on('exit', () => { focusWatcher = null })
    focusWatcher.on('error', e => { dlog('!! focuswatch ' + e.message); focusWatcher = null })
    dlog('focuswatch iniciado')
  } catch (e) { dlog('!! startFocusWatch ' + e.message) }
}
function stopFocusWatch () { try { focusWatcher && focusWatcher.kill() } catch {} focusWatcher = null }

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
  authToken = token
  dlog('enterApp email=' + email + ' telas=' + licensedTelas + ' lic=' + JSON.stringify(lic))
  win.loadFile(path.join(__dirname, 'renderer', 'host-toolbar.html'))
  win.webContents.once('did-finish-load', async () => {
    startWin32Server()   // compila o Add-Type 1x -> trocas viram ~5ms
    ensureOverlay()      // pre-aquece a cortina (curtain.html carregado antes da 1a transicao)
    await setCount(1); startPopupWatch(); registerShortcuts(); startFocusWatch()
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
  win.maximize()   // abre maximizada (pediram tela cheia do launcher)
  win.on('resize', () => scheduleRelayout())
  win.on('focus', () => scheduleRefocus())   // voltou do alt-tab -> reativa a janela do jogo

  win.on('closed', () => { win = null; try { lootWin && lootWin.close() } catch {} stopPopupWatch(); stopFocusWatch(); stopWin32Server(); killAll() })

  // boot: restaura sessao salva -> entra direto; senao mostra login
  refreshToken()
    .then(sess => { if (sess) enterApp(sess.access_token, sess.email); else win.loadFile(path.join(__dirname, 'renderer', 'login.html')) })
    .catch(() => win.loadFile(path.join(__dirname, 'renderer', 'login.html')))
}

// IPC
ipcMain.handle('relaunch', async (_e, n) => { await setCount(n); return slots.length })
ipcMain.handle('add-account', async () => { await publicAdd(); return slots.length })
ipcMain.handle('close-account', async (_e, idx) => { await publicClose(idx); return slots.length })
ipcMain.on('set-layout', (_e, m) => { if (['grid', 'columns', 'rows'].includes(m)) withCurtain(() => { layoutMode = m; return applyLayout() }, { inMs: 0, outMs: 110 }) })
ipcMain.on('set-solo', (_e, idx) => { withCurtain(() => { solo = (idx == null ? -1 : idx); return applyLayout() }, { inMs: 0, outMs: 110 }) })
ipcMain.on('set-sidebar', (_e, collapsed) => { sidebarCollapsed = !!collapsed; applyLayout() })
ipcMain.handle('get-state', () => ({ count: slots.length, embedded: currentHwnds().length, mode: layoutMode, solo, maxTelas: licensedTelas, email: authEmail }))

// --- Hunt Analyzer: abre a janela flutuante de loot (aba solta, sempre no topo) ---
ipcMain.handle('open-loot', () => {
  if (lootWin && !lootWin.isDestroyed()) { lootWin.show(); lootWin.focus(); return true }
  const b = win ? win.getBounds() : { x: 200, y: 120, width: 1200 }
  lootWin = new BrowserWindow({
    width: 320, height: 360, x: b.x + b.width - 360, y: b.y + 70,
    frame: false, resizable: true, alwaysOnTop: true, skipTaskbar: true,
    backgroundColor: '#0a0605', title: 'Loot total',
    webPreferences: { preload: path.join(__dirname, 'host-preload.js'), contextIsolation: true, nodeIntegration: false }
  })
  lootWin.setMenuBarVisibility(false)
  lootWin.loadFile(path.join(__dirname, 'renderer', 'loot.html'))
  lootWin.on('closed', () => { lootWin = null })
  return true
})

// --- Hunt Analyzer: le o loot de cada conta (via CDP) e soma ---
ipcMain.handle('read-loot', async () => {
  const results = await Promise.all(slots.map(async s => ({
    num: s.num, embedded: !!s.hwnd, loot: await cdp.readLoot(s.port)
  })))
  const total = results.reduce((a, r) => a + (r.loot || 0), 0)
  dlog('read-loot total=' + total + ' ' + JSON.stringify(results))
  return { results, total, available: cdp.available() }
})

// --- auto-update (baixa so os arquivos do app do GitHub) ---
function localVersion () {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.0.0' } catch { return '0.0.0' }
}
function cmpVer (a, b) {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1 }
  return 0
}
// le a VERSAO da release publicada (tag "vX.Y.Z" -> "X.Y.Z") + confirma que o zip existe la
async function latestReleaseInfo () {
  const r = await fetch(RELEASES_API + '?t=' + Date.now(), {
    headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'poke-multi-labs' }
  })
  if (!r.ok) throw new Error('release HTTP ' + r.status)
  const j = await r.json()
  const version = String(j.tag_name || '').replace(/^v/i, '')
  const hasZip = Array.isArray(j.assets) && j.assets.some(a => a.name === 'app-update.zip')
  return { version, notes: String(j.body || ''), hasZip }
}
ipcMain.handle('check-update', async () => {
  const cur = localVersion()
  // fonte PRIMARIA: a release publicada. manifesto e zip vem da MESMA release -> so oferece
  // update quando existe release nova de fato (mata o "atualizou mas continuou na versao velha").
  try {
    const rel = await latestReleaseInfo()
    if (rel.version) {
      return { ok: true, current: cur, latest: rel.version, notes: rel.notes,
        hasUpdate: cmpVer(rel.version, cur) > 0 && rel.hasZip, packaged: app.isPackaged, source: 'release' }
    }
  } catch (e) { dlog('check-update via release falhou (' + e.message + '), tenta manifesto do main') }
  // fallback (API do GitHub fora do ar): manifesto no main, so informativo
  try {
    const r = await fetch(REPO_RAW + '/app-version.json?t=' + Date.now())
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const man = await r.json()
    return { ok: true, current: cur, latest: man.version, hasUpdate: cmpVer(man.version, cur) > 0, packaged: app.isPackaged, source: 'main' }
  } catch (e) { dlog('!! check-update ' + e.message); return { ok: false, error: e.message } }
})
// Metodo 1 (preferido): baixa o app-update.zip da release e extrai por cima
// (traz JS/HTML/PS + modulos novos, ex node_modules/ws). Sem deps: unzip via PowerShell.
async function updateViaZip () {
  const res = await fetch(UPDATE_ZIP_URL + '?t=' + Date.now())
  if (!res.ok) throw new Error('zip HTTP ' + res.status)
  const buf = Buffer.from(await res.arrayBuffer())
  const tmp = path.join(os.tmpdir(), 'pml-upd-' + Date.now())
  const zipPath = path.join(tmp, 'app.zip')
  const outDir = path.join(tmp, 'app')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(zipPath, buf)
  await new Promise((resolve, reject) => {
    const cmd = "Expand-Archive -LiteralPath '" + zipPath + "' -DestinationPath '" + outDir + "' -Force"
    const ps = spawn('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'ignore' })
    ps.on('close', c => c === 0 ? resolve() : reject(new Error('unzip exit ' + c)))
    ps.on('error', reject)
  })
  // valida minimamente e copia por cima da pasta do app
  if (!fs.existsSync(path.join(outDir, 'host-main.js'))) throw new Error('zip sem host-main.js')
  fs.cpSync(outDir, __dirname, { recursive: true, force: true })
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}
// Metodo 2 (fallback): baixa os arquivos de texto avulsos do GitHub raw
async function updateViaFiles (man) {
  const files = (man && Array.isArray(man.files) && man.files.length) ? man.files : APP_FILES
  const blobs = {}
  for (const f of files) {
    const rr = await fetch(REPO_RAW + '/' + f + '?t=' + Date.now())
    if (!rr.ok) throw new Error('baixando ' + f + ' (' + rr.status + ')')
    blobs[f] = await rr.text()
  }
  for (const f of files) {
    const dest = path.join(__dirname, f)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, blobs[f])
  }
}
ipcMain.handle('apply-update', async () => {
  if (!app.isPackaged) return { ok: false, error: 'modo dev nao atualiza (protege o codigo-fonte)' }
  try {
    // Metodo 1: zip da release. Ele TRAZ o package.json com a versao real -> a versao local
    // vira exatamente a que foi baixada (nunca mais "diz 0.4.4 mas o codigo e 0.4.2").
    await updateViaZip()
    const applied = localVersion()   // lido do package.json que veio DENTRO do zip
    dlog('apply-update (zip) OK -> ' + applied + ' | reiniciando')
    setTimeout(() => { app.relaunch(); app.exit(0) }, 300)
    return { ok: true, version: applied }
  } catch (e) {
    dlog('update via zip falhou (' + e.message + '), fallback arquivos avulsos do main')
    // Metodo 2 (fallback, so quando o zip nao existe): arquivos avulsos do main + versao do manifesto
    try {
      const man = await (await fetch(REPO_RAW + '/app-version.json?t=' + Date.now())).json()
      await updateViaFiles(man)
      try {
        const pj = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'))
        pj.version = man.version || pj.version
        fs.writeFileSync(path.join(__dirname, 'package.json'), JSON.stringify(pj, null, 2))
      } catch {}
      const applied = localVersion()
      dlog('apply-update (fallback) OK -> ' + applied + ' | reiniciando')
      setTimeout(() => { app.relaunch(); app.exit(0) }, 300)
      return { ok: true, version: applied }
    } catch (e2) { dlog('!! apply-update ' + e2.message); return { ok: false, error: e2.message } }
  }
})

// --- sorteio: perfil do usuario (nome/discord/nick) + area de admin ---
ipcMain.handle('get-profile', async () => {
  const d = await callRpc('meu_perfil_sorteio', {})
  return Array.isArray(d) ? (d[0] || null) : null
})
ipcMain.handle('save-profile', async (_e, nome, discord, nick) => {
  await callRpc('salvar_perfil_sorteio', { p_nome: nome, p_discord: discord, p_nick: nick })
  return { ok: true }
})
ipcMain.handle('check-admin', async () => {
  const d = await callRpc('sou_admin_sorteio', {})
  return d === true
})
ipcMain.handle('list-participants', async () => {
  const d = await callRpc('listar_participantes_sorteio', {})
  if (Array.isArray(d)) return { ok: true, rows: d }
  return { ok: false, error: (d && d.message) || 'acesso negado' }
})

// --- auth ---
ipcMain.handle('login', async (_e, email, password) => {
  const r = await doSignin(email, password)
  if (r.ok) { await enterApp(r.access_token, r.email) }
  return r
})
ipcMain.handle('signup', async (_e, email, password) => doSignup(email, password))
ipcMain.handle('logout', async () => {
  clearSession(); licensedTelas = 1; authEmail = null
  stopPopupWatch(); stopFocusWatch(); unregisterShortcuts(); try { lootWin && lootWin.close() } catch {} try { overlayWin && overlayWin.close() } catch {} killAll()
  win.loadFile(path.join(__dirname, 'renderer', 'login.html'))
  return true
})

app.whenReady().then(createWindow)
app.on('will-quit', () => { unregisterShortcuts(); stopFocusWatch() })
app.on('window-all-closed', () => { unregisterShortcuts(); stopFocusWatch(); killAll(); if (process.platform !== 'darwin') app.quit() })
