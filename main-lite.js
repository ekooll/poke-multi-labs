// ============================================================
// main-lite.js — Vperts Multi (versao LEVE, migrada pro Electron).
// Reusa a SIDEBAR ORIGINAL (renderer/host-toolbar.html + host-preload.js)
// e o DASHBOARD original, mas renderiza as contas EMBUTIDAS (WebContentsView)
// em vez de Chrome real reparentado. Implementa o contrato window.ml que a
// sidebar espera. Frameless + borda vermelha do site + eco mode.
//   - login Google funciona (UA Chrome + popup) — testado 21/07
//   - bridge automatico: vperts-ext/content.js como PRELOAD (wrap do WS)
// NAO toca no host-main.js (app pago). Rodar: npx electron main-lite.js
// ============================================================
const { app, BaseWindow, WebContentsView, BrowserWindow, session, Menu, ipcMain } = require('electron');
const path = require('path');
const cdp = require('./cdp.js');
process.on('uncaughtException', (e) => console.error('[lite] FATAL', e && e.stack || e));
// pasta de dados propria (isola cache/login; evita colisao com outros Electron)
app.setPath('userData', path.join(app.getPath('appData'), 'VpertsMultiLite'));

const GAME = 'https://poke.idleworld.online';
const LOGIN = GAME + '/login';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BRIDGE = path.join(__dirname, 'vperts-ext', 'content.js');
const MAX = 4;                  // regra do jogo: 4/IP
const START = 4;                // abre 4 (assinante); pode fechar com o ✕

const B = 2;                    // borda vermelha (px)
const TITLE_H = 32;
const SIDE_FULL = 206, SIDE_RAIL = 56;
const BORDER_COLOR = '#8e1d19'; // --red-deep do site
const EMAIL = 'ekoo.games@gmail.com';

let win = null, titlebar = null, sidebar = null, statsView = null, dash = null;
const slots = [];               // { num, view, connected }
let ecoOn = true;
let fpsOn = false;              // overlay de fps por conta (canto sup. direito)
let statsMode = false;          // modo stats: jogos ao fundo (1fps) + grid de stats na tela toda
let mode = 'grid';              // 'grid' | 'rows' | 'columns'
let solo = -1;                  // -1 = todas; senao indice do slot
let sideW = SIDE_FULL;          // largura da sidebar (rail quando recolhida)

const range = (n) => Array.from({ length: n }, (_, i) => i);
const HIDDEN = { x: 0, y: 0, width: 0, height: 0 };

// ---- Throttle de fps por tela (o cap REAL e instalado no preload content.js) ----
// visivel + eco = 15fps · visivel sem eco = full(0) · ESCONDIDA (fora de foco) = BG_FPS
const BG_FPS = 3;               // telas fora de foco caem pra ~3fps -> a focada fica suave
const setCap = (wc, fps) => wc.executeJavaScript('window.__vpFpsCap=' + (fps || 0)).catch(() => {});

// atalhos de teclado (valem com qualquer tela em foco): Ctrl+1..4 foca a conta · Ctrl+0/G = grade
function attachShortcuts (wc) {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
    const k = input.key;
    if (k >= '1' && k <= String(MAX)) { const i = +k - 1; if (slots[i]) { solo = i; layout(); emitState(); event.preventDefault(); } }
    else if (k === '0' || k === 'g' || k === 'G') { solo = -1; layout(); emitState(); event.preventDefault(); }
  });
}

// ---- FPS overlay: contador verde no canto sup. direito de cada conta ----
const FPS_ON = "(()=>{if(window.__vpfps)return;var b=document.createElement('div');b.id='__vpfps';" +
  "b.style.cssText='position:fixed;top:6px;right:8px;z-index:2147483647;font:800 12px Inter,Consolas,monospace;" +
  "color:#4fc47a;background:rgba(0,0,0,.55);padding:2px 7px;border-radius:7px;pointer-events:none;text-shadow:0 1px 2px #000';" +
  "b.textContent='-- fps';(document.body||document.documentElement).appendChild(b);window.__vpfps=b;" +
  "var f=0,last=performance.now();(function loop(){if(!window.__vpfps)return;f++;var n=performance.now();" +
  "if(n-last>=500){b.textContent=Math.round(f*1000/(n-last))+' fps';f=0;last=n;}window.__vpfpsRAF=requestAnimationFrame(loop);})();})();";
const FPS_OFF = "(()=>{if(window.__vpfps){window.__vpfps.remove();window.__vpfps=null;}if(window.__vpfpsRAF)cancelAnimationFrame(window.__vpfpsRAF);})();";
const applyFps = (wc) => { wc.executeJavaScript(fpsOn ? FPS_ON : FPS_OFF).catch(() => {}); };

function nextFreeNum () { for (let n = 1; n <= MAX; n++) if (!slots.some(s => s.num === n)) return n; return null; }

function openAccount (num) {
  const partition = `persist:vperts-conta${num}`;
  session.fromPartition(partition).setUserAgent(CHROME_UA);
  const view = new WebContentsView({
    webPreferences: { partition, preload: BRIDGE, contextIsolation: false, backgroundThrottling: false },
  });
  const wc = view.webContents;
  const slot = { num, view, connected: false };
  wc.setUserAgent(CHROME_UA);
  wc.setAudioMuted(true);        // 4 jogos tocando som = peso inutil -> muta tudo
  attachShortcuts(wc);           // Ctrl+1..4 / Ctrl+0 mesmo com o jogo em foco
  wc.setWindowOpenHandler(({ url }) => ({ action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680 } }));
  wc.on('dom-ready', () => { slot._tk = null; layout(); applyFps(wc); });
  const onNav = (_e, url) => { slot.connected = /\/play|\/game/.test(url) && !/\/login|\/register/.test(url); emitState(); };
  wc.on('did-navigate', onNav);
  wc.on('did-navigate-in-page', onNav);
  wc.loadURL(LOGIN);
  slots.push(slot);
  win.contentView.addChildView(view);
  return slot;
}
function closeSlot (i) {
  const s = slots[i]; if (!s) return;
  try { win.contentView.removeChildView(s.view); } catch {}
  try { s.view.webContents.close(); } catch {}
  slots.splice(i, 1);
  if (solo >= slots.length) solo = -1;
}

// tila n retangulos conforme a orientacao
function tiler (x, y, W, H, n, m) {
  let cols, rows;
  if (n <= 1) { cols = 1; rows = 1; }
  else if (m === 'columns') { cols = n; rows = 1; }   // lado a lado
  else if (m === 'rows') { cols = 1; rows = n; }       // empilhadas
  else { cols = Math.ceil(Math.sqrt(n)); rows = Math.ceil(n / cols); }
  const rects = [], rowH = Math.floor(H / rows);
  for (let r = 0; r < rows; r++) {
    const inRow = Math.min(cols, n - r * cols); if (inRow <= 0) break;
    const colW = Math.floor(W / inRow), yy = y + r * rowH;
    const hh = (r === rows - 1) ? (H - rowH * (rows - 1)) : rowH;
    for (let c = 0; c < inRow; c++) {
      const xx = x + c * colW, ww = (c === inRow - 1) ? (W - colW * (inRow - 1)) : colW;
      rects.push({ x: xx, y: yy, width: ww, height: hh });
    }
  }
  return rects;
}

function layout () {
  if (!win) return;
  const { width: W, height: H } = win.getContentBounds();
  titlebar.setBounds({ x: B, y: B, width: W - 2 * B, height: TITLE_H });
  const topY = B + TITLE_H, areaH = Math.max(0, H - 2 * B - TITLE_H);
  sidebar.setBounds({ x: B, y: topY, width: sideW, height: areaH });
  const gx = B + sideW, gw = Math.max(0, W - B - gx);
  const vis = (solo >= 0 && slots[solo]) ? [slots[solo]] : slots;
  const visSet = new Set(vis);
  if (statsMode) {
    slots.forEach(s => s.view.setBounds(HIDDEN));           // jogos ao fundo
    if (statsView) statsView.setBounds({ x: gx, y: topY, width: gw, height: areaH });
  } else {
    if (statsView) statsView.setBounds(HIDDEN);
    const rects = tiler(gx, topY, gw, areaH, vis.length, mode);
    slots.forEach(s => s.view.setBounds(HIDDEN));
    vis.forEach((s, k) => s.view.setBounds(rects[k]));
  }
  // fps por tela: stats=1fps · escondida=BG_FPS · visivel+eco=15 · visivel=full (so re-injeta quando muda)
  slots.forEach(s => {
    const key = statsMode ? 'stats' : (!visSet.has(s) ? 'bg' : (ecoOn ? 'eco' : 'full'));
    if (s._tk !== key) { s._tk = key; setCap(s.view.webContents, key === 'stats' ? 1 : key === 'bg' ? BG_FPS : key === 'eco' ? 15 : 0); }
  });
}

function stateObj () {
  return {
    mode, count: slots.length, maxTelas: MAX, solo,
    embedded: slots.filter(s => s.connected).length, email: EMAIL,
    slots: slots.map((s, i) => ({ i, num: s.num, embedded: s.connected })),
  };
}
function emitState () { if (sidebar && !sidebar.webContents.isDestroyed()) sidebar.webContents.send('state', stateObj()); }

function buildChrome () {
  titlebar = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'lite-titlebar-preload.js') } });
  titlebar.webContents.loadFile(path.join(__dirname, 'renderer', 'lite-titlebar.html'));
  win.contentView.addChildView(titlebar);
  attachShortcuts(titlebar.webContents);

  sidebar = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'host-preload.js'), contextIsolation: true } });
  sidebar.webContents.loadFile(path.join(__dirname, 'renderer', 'host-toolbar.html'));
  sidebar.webContents.on('did-finish-load', emitState);
  win.contentView.addChildView(sidebar);
  attachShortcuts(sidebar.webContents);

  statsView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'host-preload.js'), contextIsolation: true } });
  statsView.webContents.loadFile(path.join(__dirname, 'renderer', 'stats-grid.html'));
  win.contentView.addChildView(statsView);
  attachShortcuts(statsView.webContents);
}

function openDashboard () {
  if (dash && !dash.isDestroyed()) { if (dash.isMinimized()) dash.restore(); dash.show(); dash.focus(); return; }
  dash = new BrowserWindow({
    width: 490, height: 800, minWidth: 380, minHeight: 340, parent: win, frame: false,
    resizable: true, skipTaskbar: true, backgroundColor: '#0a0605',
    webPreferences: { preload: path.join(__dirname, 'host-preload.js'), contextIsolation: true },
  });
  dash.loadFile(path.join(__dirname, 'renderer', 'dashboard-lite.html'));
  dash.on('closed', () => { dash = null; });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  win = new BaseWindow({ width: 1720, height: 1000, minWidth: 940, minHeight: 620,
    frame: false, backgroundColor: BORDER_COLOR, title: 'Vperts Multi' });
  buildChrome();
  for (let k = 0; k < START; k++) openAccount(nextFreeNum());
  layout();
  console.log('[lite] pronto —', slots.length, 'contas abertas');
  win.on('resize', layout); win.on('maximize', layout); win.on('unmaximize', layout);
});

// ---------------- titlebar (controles de janela + eco) ----------------
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:maximize', () => { if (win) win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.on('win:close', () => { try { app.quit(); } catch {} });
ipcMain.handle('lite:eco', () => { ecoOn = !ecoOn; slots.forEach(s => { s._tk = null; }); layout(); return ecoOn; });
ipcMain.handle('lite:eco-state', () => ecoOn);
ipcMain.handle('lite:fps', () => { fpsOn = !fpsOn; slots.forEach(s => applyFps(s.view.webContents)); return fpsOn; });
ipcMain.handle('lite:fps-state', () => fpsOn);
ipcMain.handle('lite:stats', () => { statsMode = !statsMode; layout(); if (statsMode && statsView) statsView.webContents.executeJavaScript('window.__refresh&&window.__refresh()').catch(() => {}); return statsMode; });
ipcMain.handle('lite:stats-state', () => statsMode);

// ---------------- window.ml (contrato da sidebar original) ----------------
ipcMain.handle('get-state', () => stateObj());
ipcMain.on('set-layout', (_e, m) => { mode = m; layout(); emitState(); });
ipcMain.on('set-solo', (_e, i) => { solo = i; layout(); emitState(); });
ipcMain.on('set-sidebar', (_e, collapsed) => { sideW = collapsed ? SIDE_RAIL : SIDE_FULL; layout(); });
ipcMain.handle('relaunch', (_e, n) => { n = Math.max(1, Math.min(MAX, n | 0)); while (slots.length > n) closeSlot(slots.length - 1); while (slots.length < n) openAccount(nextFreeNum()); layout(); emitState(); });
ipcMain.handle('add-account', () => { if (slots.length < MAX) { openAccount(nextFreeNum()); layout(); emitState(); } });
ipcMain.handle('close-account', (_e, i) => { closeSlot(i); layout(); emitState(); });
ipcMain.handle('open-dashboard', () => { openDashboard(); return true; });

// dashboard (reaproveitado)
ipcMain.handle('read-dashboard', async () => {
  const results = [];
  let changed = false;
  for (const s of slots) {
    let state = null;
    try { state = await s.view.webContents.executeJavaScript(cdp.STATE_EXPR, true); }
    catch (e) { state = { ok: false, err: String(e && e.message || e) }; }
    const conn = !!(state && state.ok && (state.name || state.level != null));
    if (conn !== s.connected) { s.connected = conn; changed = true; }
    results.push({ num: s.num, state, embedded: true });
  }
  if (changed) emitState();
  return { available: true, results };
});
ipcMain.handle('dashboard-pin', (_e, on) => { if (dash) dash.setAlwaysOnTop(!!on); });
ipcMain.handle('dashboard-minimize', () => { if (dash) dash.minimize(); });
ipcMain.handle('dashboard-resize', (_e, w, h) => { if (dash) dash.setSize(Math.max(360, Math.round(w)), Math.max(320, Math.round(h))); });

// ---------------- stubs (features do app pago que a sidebar chama) ----------------
ipcMain.handle('logout', () => ({ ok: true }));            // no-op (feche pelo ✕)
ipcMain.handle('login', () => ({ ok: true }));
ipcMain.handle('signup', () => ({ ok: true }));
ipcMain.handle('read-loot', () => null);
ipcMain.handle('open-loot', () => true);
ipcMain.handle('check-update', () => ({ ok: true, hasUpdate: false, current: 'lite', packaged: false }));
ipcMain.handle('apply-update', () => ({ ok: false }));
ipcMain.handle('get-profile', () => null);
ipcMain.handle('save-profile', () => ({ ok: true }));
ipcMain.handle('check-admin', () => false);
ipcMain.handle('list-participants', () => ({ ok: false }));

app.on('window-all-closed', () => app.quit());
