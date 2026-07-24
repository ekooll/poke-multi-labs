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
// PORTA DE DEBUG (so 127.0.0.1). O modo Leve roda o jogo dentro do proprio Electron, entao
// nao existia porta nenhuma — e o coletor de conferencia (_coleta/coletor.js), que compara o
// nosso card com o Hunt Analyzer do jogo, ficava logando "app fechado" pra sempre, calado.
// Mesma porta base do host (9333) pra a ferramenta achar nos dois modos.
app.commandLine.appendSwitch('remote-debugging-port', '9333');
app.commandLine.appendSwitch('remote-allow-origins', '*');

const GAME = 'https://poke.idleworld.online';
const LOGIN = GAME + '/login';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BRIDGE = path.join(__dirname, 'vperts-ext', 'content.js');
const MAX = 4;                  // regra do jogo: 4/IP
const START = 4;                // beta gratuito: abre as 4; pode fechar com o ✕

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
  const onNav = (_e, url) => { slot.connected = /\/play|\/game/.test(url) && !/\/login|\/register/.test(url); emitState(); };
  wc.on('did-navigate', onNav);
  wc.on('did-navigate-in-page', onNav);
  // com sessao guardada vai direto pro jogo; se o token tiver expirado o proprio jogo
  // manda de volta pro /login
  wc.loadURL(sessions[num] ? GAME + '/play' : LOGIN);
  slots.push(slot);
  win.contentView.addChildView(view);
  // O CARD TEM QUE ENTRAR DEPOIS DA TELA DO JOGO. z-order aqui e a ordem de addChildView:
  // com o abreOverlay antes do addChildView(view), o jogo era desenhado POR CIMA do card e
  // ele nunca aparecia no boot - so depois de desligar/ligar o botao Cards, que recria os
  // overlays por ultimo. Era esse o bug do "Cards: ON sem card na tela".
  if (overlayOn) abreOverlay(slot);
  return slot;
}
// ---- OVERLAY por conta: o card flutua SOBRE a tela daquela conta ----
// Uma WebContentsView transparente por slot, encostada no canto de cima da tela dela.
// Fica pequena de proposito: a area do card nao recebe clique do jogo.
// tamanho PADRAO do card (o dono muda arrastando o canto - card:size guarda por conta).
// Subiu de 268x196 quando o card ganhou avatar, subtitulo do poke, barra de HP e o grip.
const OV_W = 292, OV_H = 258, OV_PAD = 10;
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
      // tamanho: o que o dono deixou no resize (card:size), nunca maior que a tela da conta
      const w = Math.min(s.ovW || OV_W, r.width), h = Math.min(s.ovH || OV_H, r.height);
      // posicao: o quanto ele arrastou (card:move), preso dentro da tela daquela conta pra
      // o card nunca escapar pro vizinho nem sumir fora da area visivel
      // sem arrasto, o card nasce com um respiro do canto (antes esse respiro era o
      // margin:10px do CSS; agora o card ocupa 100% da view pra o resize funcionar)
      const px = s.ovDX == null ? OV_PAD : s.ovDX, py = s.ovDY == null ? OV_PAD : s.ovDY;
      const dx = Math.max(0, Math.min(px, Math.max(0, r.width  - w)));
      const dy = Math.max(0, Math.min(py, Math.max(0, r.height - h)));
      s._rect = r;              // guardado pro card:move poder limitar o arrasto na origem
      s.ovDX = dx; s.ovDY = dy; // grava JA limitado: senao o offset crescia sem teto ao
      s.ovW = w; s.ovH = h;     // arrastar pra fora e o card "travava" ate desfazer tudo
      s.ov.setBounds({ x: Math.round(r.x + dx), y: Math.round(r.y + dy),
                       width: Math.round(w), height: Math.round(h) });
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

// ---------------- card: arrastar, redimensionar e zerar ----------------
// O card e uma WebContentsView, entao quem move e o main: o renderer so manda o quanto o
// mouse andou (em px de TELA, nao da pagina - a view se move junto e o delta local mentiria).
const acha = (num) => slots.find(x => x.num === num);
ipcMain.on('card:move', (_e, num, dx, dy) => {
  const s = acha(num); if (!s) return;
  const r = s._rect, w = s.ovW || OV_W, h = s.ovH || OV_H;
  const maxX = r ? Math.max(0, r.width - w) : Infinity;
  const maxY = r ? Math.max(0, r.height - h) : Infinity;
  // limita JA na acumulacao. Antes so limitava ao desenhar: arrastar pra fora inflava o
  // offset (ex: 4000px), e pra mover de novo era preciso desfazer tudo = parecia travado.
  s.ovDX = Math.max(0, Math.min(maxX, (s.ovDX == null ? OV_PAD : s.ovDX) + (dx || 0)));
  s.ovDY = Math.max(0, Math.min(maxY, (s.ovDY == null ? OV_PAD : s.ovDY) + (dy || 0)));
  layout();
});
ipcMain.on('card:size', (_e, num, dw, dh) => {
  const s = acha(num); if (!s) return;
  // minimo 230x170: abaixo disso o cabecalho + grip nao cabiam e o grip saia da tela -
  // o card ficava sem AREA DE ARRASTO, ou seja, preso onde estava.
  s.ovW = Math.max(230, Math.min(620, (s.ovW || OV_W) + (dw || 0)));
  s.ovH = Math.max(170, Math.min(680, (s.ovH || OV_H) + (dh || 0)));
  layout();
});
// volta o card pro canto, no tamanho padrao (duplo-clique no grip)
ipcMain.on('card:home', (_e, num) => {
  const s = acha(num); if (!s) return;
  s.ovDX = null; s.ovDY = null; s.ovW = OV_W; s.ovH = OV_H;   // null = volta pro respiro padrao
  layout();
});
// lixeira: zera a sessao da conta igual o jogo faz na troca de hunt (window.__vpReset vem
// do vperts-ext/content.js). Historico de capturas/fotos NAO e apagado.
ipcMain.handle('card:reset', async (_e, num) => {
  const s = acha(num); if (!s) return false;
  try { return !!(await s.view.webContents.executeJavaScript('!!(window.__vpReset && window.__vpReset())')); }
  catch { return false; }
});

// ---------------- window.ml (contrato da sidebar original) ----------------
ipcMain.handle('get-state', () => stateObj());
ipcMain.on('set-layout', (_e, m) => { mode = m; layout(); emitState(); });
ipcMain.on('set-solo', (_e, i) => { solo = i; layout(); emitState(); });
ipcMain.on('set-sidebar', (_e, collapsed) => { sideW = collapsed ? SIDE_RAIL : SIDE_FULL; layout(); });
ipcMain.handle('relaunch', (_e, n) => { n = Math.max(1, Math.min(MAX, n | 0)); while (slots.length > n) closeSlot(slots.length - 1); while (slots.length < n) openAccount(nextFreeNum()); layout(); emitState(); });
ipcMain.handle('add-account', () => { if (slots.length < MAX) { openAccount(nextFreeNum()); layout(); emitState(); } });
ipcMain.handle('close-account', (_e, i) => { closeSlot(i); layout(); emitState(); });
ipcMain.handle('open-dashboard', () => { openDashboard(); return true; });

// ---- dashboard (reaproveitado) ----
// UMA leitura serve pra todo mundo. Os overlays (1s), o dashboard (4s) e o grid de stats
// (2,5s) chamam esse handler, e cada chamada varre TODAS as contas — dava ate 5 leituras por
// segundo por conta dentro do renderer do jogo. Agora: resposta com menos de CACHE_MS volta
// do cache, e chamadas simultaneas compartilham a MESMA promessa em vez de enfileirar.
// CACHE_MS baixou p/ 800: o card de HP/XP precisa acompanhar a batalha (era 1500). O leitor
// com bridge vivo so le o localStorage (nao varre o DOM), entao 800ms e' barato.
const CACHE_MS = 800;
let leituraCache = null, leituraTs = 0, leituraEmVoo = null;

async function lerContas () {
  const results = [];
  let changed = false;
  for (const s of slots) {
    let state = null;
    try { state = await s.view.webContents.executeJavaScript(cdp.STATE_EXPR, true); }
    catch (e) { state = { ok: false, err: String(e && e.message || e) }; }
    // "conectada" agora vale pelo sinal do WS tambem: sem varrer o DOM o leitor nao devolve
    // mais name/level, e so por isso a sidebar marcaria as contas como desconectadas.
    const conn = !!(state && state.ok && (state.name || state.level != null ||
      (state.live && state.live.msgs)));
    if (conn !== s.connected) { s.connected = conn; changed = true; }
    results.push({ num: s.num, state, embedded: true });
  }
  if (changed) emitState();
  return { available: true, results };
}

ipcMain.handle('read-dashboard', async () => {
  if (leituraCache && (Date.now() - leituraTs) < CACHE_MS) return leituraCache;
  if (leituraEmVoo) return leituraEmVoo;                       // ja tem uma lendo: pega carona
  leituraEmVoo = lerContas()
    .then(r => { leituraCache = r; leituraTs = Date.now(); return r; })
    .finally(() => { leituraEmVoo = null; });
  return leituraEmVoo;
});
// ---- leitura LEVE do HP/XP do lider (loop rapido do card, 250ms) ----
// O read-dashboard roda o STATE_EXPR inteiro (pesado) e e' cacheado 800ms — bom pro card todo,
// mas lento demais pra barra de HP acompanhar a batalha. Este le SO os campos crus do lider do
// localStorage (bem barato) com cache curto, pra o overlay atualizar so as barras rapido.
// le a chave RAPIDA `__vpHero` (escrita a cada mensagem) pro HP/XP; o `__vperts` (1x/s) so
// entra pra xpThresholds e o roster de fallback. E' o que torna a barra fluida.
const HERO_EXPR = `(function(){try{
  var H=JSON.parse(localStorage.getItem('__vpHero')||'null');
  var V=JSON.parse(localStorage.getItem('__vperts')||'{}');var L=V.lider||{};
  return {heroHp:(H&&H.hp!=null)?H.hp:V.heroHp, heroMaxHp:(H&&H.mx!=null)?H.mx:V.heroMaxHp,
    heroFainted:(H?!!H.ko:!!V.heroFainted), liderXp:(H&&H.xp!=null)?H.xp:V.liderXp, liderLevel:(H&&H.lvl!=null)?H.lvl:V.liderLevel,
    xpThresholds:V.xpThresholds, rosterHp:L.hp, rosterMaxHp:L.maxHp, rosterLevel:L.level}}catch(e){return null}})()`;
let heroCache = null, heroTs = 0, heroVoo = null;
async function lerHerois () {
  const out = {};
  for (const s of slots) {
    try { out[s.num] = await s.view.webContents.executeJavaScript(HERO_EXPR, true); }
    catch (e) { out[s.num] = null; }
  }
  return out;
}
ipcMain.handle('read-hero', async () => {
  if (heroCache && (Date.now() - heroTs) < 90) return heroCache;
  if (heroVoo) return heroVoo;
  heroVoo = lerHerois().then(r => { heroCache = r; heroTs = Date.now(); return r; }).finally(() => { heroVoo = null; });
  return heroVoo;
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
