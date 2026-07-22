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
const { app, BaseWindow, WebContentsView, BrowserWindow, session, Menu, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
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
// a versao leve nao tem login (os handlers de auth sao stub) — nao cravar e-mail de
// ninguem aqui: o zip de teste ia pra outra pessoa mostrando a conta do dono na sidebar
const EMAIL = null;

let win = null, titlebar = null, sidebar = null, statsView = null, dash = null;
const slots = [];               // { num, view, connected }
let ecoOn = true;
let fpsOn = false;              // overlay de fps por conta (canto sup. direito)
let statsMode = false;          // modo stats: jogos ao fundo (1fps) + grid de stats na tela toda
let mode = 'grid';              // 'grid' | 'rows' | 'columns'
let solo = -1;                  // -1 = todas; senao indice do slot
let sideW = SIDE_FULL;          // largura da sidebar (rail quando recolhida)
let focusNum = 0;               // conta com foco (0 = nenhuma ainda -> todas contam como focada)

const range = (n) => Array.from({ length: n }, (_, i) => i);
const HIDDEN = { x: 0, y: 0, width: 0, height: 0 };

// ---- Orcamento de fps por tela (o cap REAL e instalado no preload content.js) ----
// A tela em FOCO leva o orcamento cheio e as outras cedem. E isso que da a sensacao de
// fluidez sem gastar mais CPU: antes TODAS ficavam em 15fps e o app inteiro parecia duro.
const FPS = {
  focus:   { eco: 30, full: 0 },   // conta em que o usuario esta mexendo (0 = sem cap)
  visible: { eco: 15, full: 30 },  // demais telas da grade — 15 alinhado ao vsync ja e suave
  hidden:  3,                      // fora da grade (modo solo) — so mantendo o tick
  stats:   1,                      // modo Estatisticas: jogos so segurando a sessao
};
// __vpKick migra os frames pendentes quando o cap cai (tela que sumiu) — ver content.js
const setCap = (wc, fps) => wc.executeJavaScript(
  'window.__vpFpsCap=' + (fps || 0) + ';window.__vpKick&&window.__vpKick()').catch(() => {});

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

// ---- SESSAO POR CONTA (abrir ja logado) ----
// O token do jogo vive no sessionStorage, que nao sobrevive a fechar o app. Guardamos aqui,
// um por conta, CRIPTOGRAFADO pela DPAPI do Windows (safeStorage): so a conta de Windows
// que gravou consegue ler, e nada sai da maquina. Sem criptografia disponivel, NAO grava —
// token em texto puro no disco nao vale a conveniencia.
const SESS_FILE = path.join(app.getPath('userData'), 'sessions.dat');
let sessions = {};
function loadSessions () {
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    sessions = JSON.parse(safeStorage.decryptString(fs.readFileSync(SESS_FILE))) || {};
    const n = Object.keys(sessions).length;
    if (n) console.log('[lite] sessao restaurada de', n, 'conta(s)');
  } catch { sessions = {}; }        // arquivo ausente/ilegivel: comeca do zero, cai no login
}
function saveSessions () {
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    fs.writeFileSync(SESS_FILE, safeStorage.encryptString(JSON.stringify(sessions)));
  } catch (e) { console.error('[lite] nao consegui gravar a sessao:', e && e.message); }
}
const slotDe = (wc) => slots.find(s => s.view.webContents === wc) || null;
// sendSync: o preload PRECISA do token antes dos scripts do jogo rodarem
ipcMain.on('vperts:token-get', (e) => { const s = slotDe(e.sender); e.returnValue = (s && sessions[s.num]) || null; });
ipcMain.on('vperts:token-set', (e, tok) => {
  const s = slotDe(e.sender); if (!s) return;                 // popup do Google, por exemplo
  if (tok) sessions[s.num] = tok; else delete sessions[s.num];  // sem token = deslogou
  saveSessions();
});

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
  // clicou na tela = ela vira a "principal" e recebe o orcamento de fps cheio
  wc.on('focus', () => { if (focusNum !== num) { focusNum = num; layout(); } });
  wc.setWindowOpenHandler(({ url }) => ({ action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680 } }));
  wc.on('dom-ready', () => { slot._tk = null; layout(); applyFps(wc); });
  if (overlayOn) abreOverlay(slot);
  const onNav = (_e, url) => { slot.connected = /\/play|\/game/.test(url) && !/\/login|\/register/.test(url); emitState(); };
  wc.on('did-navigate', onNav);
  wc.on('did-navigate-in-page', onNav);
  // com sessao guardada vai direto pro jogo; se o token tiver expirado o proprio jogo
  // manda de volta pro /login
  wc.loadURL(sessions[num] ? GAME + '/play' : LOGIN);
  slots.push(slot);
  win.contentView.addChildView(view);
  return slot;
}
// ---- OVERLAY por conta: o card flutua SOBRE a tela daquela conta ----
// Uma WebContentsView transparente por slot, encostada no canto de cima da tela dela.
// Fica pequena de proposito: a area do card nao recebe clique do jogo.
const OV_W = 268, OV_H = 196;
let overlayOn = true;
function abreOverlay (s) {
  if (s.ov) return s.ov;
  const v = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'host-preload.js'), contextIsolation: true, transparent: true } });
  try { v.setBackgroundColor('#00000000'); } catch {}
  v.webContents.loadFile(path.join(__dirname, 'renderer', 'overlay.html'), { query: { num: String(s.num) } });
  attachShortcuts(v.webContents);
  win.contentView.addChildView(v);       // entra depois dos jogos = fica por cima
  s.ov = v;
  return v;
}
function fechaOverlay (s) {
  if (!s.ov) return;
  try { win.contentView.removeChildView(s.ov); } catch {}
  try { s.ov.webContents.close(); } catch {}
  s.ov = null;
}

function closeSlot (i) {
  const s = slots[i]; if (!s) return;
  fechaOverlay(s);
  try { win.contentView.removeChildView(s.view); } catch {}
  try { s.view.webContents.close(); } catch {}
  if (s.num === focusNum) focusNum = 0;   // sem dono do foco: as restantes voltam ao teto
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
    slots.forEach(s => { s.view.setBounds(HIDDEN); if (s.ov) s.ov.setBounds(HIDDEN); });   // jogos ao fundo
    if (statsView) statsView.setBounds({ x: gx, y: topY, width: gw, height: areaH });
  } else {
    if (statsView) statsView.setBounds(HIDDEN);
    const rects = tiler(gx, topY, gw, areaH, vis.length, mode);
    slots.forEach(s => s.view.setBounds(HIDDEN));
    vis.forEach((s, k) => s.view.setBounds(rects[k]));
    // o overlay acompanha o canto de cima da tela da conta
    slots.forEach(s => { if (!s.ov) return;
      const k = vis.indexOf(s);
      if (k < 0 || !overlayOn) return s.ov.setBounds(HIDDEN);
      const r = rects[k];
      s.ov.setBounds({ x: r.x, y: r.y, width: Math.min(OV_W, r.width), height: Math.min(OV_H, r.height) });
    });
  }
  // fps por tela (so re-injeta quando o valor muda) — ver a tabela FPS la em cima
  slots.forEach(s => {
    let cap;
    if (statsMode) cap = FPS.stats;
    else if (!visSet.has(s)) cap = FPS.hidden;
    else {
      // sozinha na tela ou ainda sem foco definido = trata como focada (nunca fica pior)
      const t = (vis.length === 1 || !focusNum || s.num === focusNum) ? FPS.focus : FPS.visible;
      cap = ecoOn ? t.eco : t.full;
    }
    if (s._tk !== cap) { s._tk = cap; setCap(s.view.webContents, cap); }
  });
}

// resize dispara dezenas de eventos por segundo; recalcular tudo em cada um trava o arrasto
let relayoutT = null;
function relayout () { if (relayoutT) return; relayoutT = setTimeout(() => { relayoutT = null; layout(); }, 16); }

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
}

// A tela de Estatisticas nasce SO quando o modo e ligado. Antes ela era criada no boot e,
// mesmo invisivel, ficava varrendo as 4 contas de 2,5 em 2,5s — um renderer a mais na RAM
// e uma engasgada periodica em quem nunca abriu o modo.
function ensureStats () {
  if (statsView) return statsView;
  statsView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'host-preload.js'), contextIsolation: true } });
  statsView.webContents.loadFile(path.join(__dirname, 'renderer', 'stats-grid.html'));
  statsView.webContents.on('did-finish-load', syncStats);
  win.contentView.addChildView(statsView);
  attachShortcuts(statsView.webContents);
  return statsView;
}
// so pesquisa as contas enquanto o modo esta ligado (o HTML checa window.__vpActive)
function syncStats () {
  if (!statsView || statsView.webContents.isDestroyed()) return;
  statsView.webContents.executeJavaScript(
    'window.__vpActive=' + statsMode + ';window.__vpActive&&window.__refresh&&window.__refresh()').catch(() => {});
}

function openDashboard () {
  if (dash && !dash.isDestroyed()) { if (dash.isMinimized()) dash.restore(); dash.show(); dash.focus(); return; }
  dash = new BrowserWindow({
    width: 1000, height: 760, minWidth: 460, minHeight: 340, parent: win, frame: false,
    resizable: true, skipTaskbar: true, backgroundColor: '#0a0605',
    webPreferences: { preload: path.join(__dirname, 'host-preload.js'), contextIsolation: true },
  });
  dash.loadFile(path.join(__dirname, 'renderer', 'dashboard-lite.html'));
  dash.on('closed', () => { dash = null; });
}

// Flags do Chromium (equivalem as CHROME_FLAGS que o app pago passa pro Chrome real):
// o jogo e idle, entao NADA pode ser jogado pra segundo plano so porque a janela perdeu o
// foco ou ficou coberta — sem isso o Chromium throttla timers/render e o jogo "engasga".
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('enable-gpu-rasterization');   // canvas do jogo vai pra GPU
app.commandLine.appendSwitch('enable-zero-copy');

// Uma instancia so. Duas apontando pro mesmo userData brigam pelo cache e pelos cookies
// ("Unable to move the cache: Acesso negado") e podem derrubar o login das contas.
const SOZINHO = app.requestSingleInstanceLock();
if (!SOZINHO) app.quit();
else app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  if (!SOZINHO) return;
  Menu.setApplicationMenu(null);
  loadSessions();               // antes de abrir as contas: decide /play vs /login
  win = new BaseWindow({ width: 1720, height: 1000, minWidth: 940, minHeight: 620,
    frame: false, backgroundColor: BORDER_COLOR, title: 'Vperts Multi' });
  buildChrome();
  for (let k = 0; k < START; k++) openAccount(nextFreeNum());
  layout();
  console.log('[lite] pronto —', slots.length, 'contas abertas');
  win.on('resize', relayout); win.on('maximize', relayout); win.on('unmaximize', relayout);
});

// ---------------- titlebar (controles de janela + eco) ----------------
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:maximize', () => { if (win) win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.on('win:close', () => { try { app.quit(); } catch {} });
ipcMain.handle('lite:eco', () => { ecoOn = !ecoOn; slots.forEach(s => { s._tk = null; }); layout(); return ecoOn; });
ipcMain.handle('lite:eco-state', () => ecoOn);
ipcMain.handle('lite:fps', () => { fpsOn = !fpsOn; slots.forEach(s => applyFps(s.view.webContents)); return fpsOn; });
ipcMain.handle('lite:fps-state', () => fpsOn);
ipcMain.handle('lite:stats', () => { statsMode = !statsMode; if (statsMode) ensureStats(); layout(); syncStats(); return statsMode; });
ipcMain.handle('lite:stats-state', () => statsMode);
ipcMain.handle('lite:overlay', () => {
  overlayOn = !overlayOn;
  slots.forEach(s => overlayOn ? abreOverlay(s) : fechaOverlay(s));
  layout();
  return overlayOn;
});
ipcMain.handle('lite:overlay-state', () => overlayOn);

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
