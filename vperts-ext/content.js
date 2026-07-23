// ---- SESSAO: abrir o app ja logado ----
// O jogo guarda o token em sessionStorage['pokeweb:tokens'], que MORRE quando a janela
// fecha — por isso toda abertura caía no /login, mesmo com a particao persistente (cookie
// e localStorage sobrevivem, sessionStorage nao). Aqui a gente devolve o token guardado
// ANTES dos scripts do jogo rodarem e avisa o main quando ele muda. Quem guarda e o main,
// CRIPTOGRAFADO com a DPAPI do Windows (safeStorage) — o token nao sai da maquina.
(function () {
  var KEY = 'pokeweb:tokens', ipc = null;
  try { ipc = require('electron').ipcRenderer; } catch (e) { return; }   // no app pago roda como extensao: sem ipc
  if (!ipc || !/(^|\.)idleworld\.online$/.test(location.hostname)) return;  // so no dominio do jogo
  try {
    if (!sessionStorage.getItem(KEY)) {
      var tok = ipc.sendSync('vperts:token-get');
      if (tok) sessionStorage.setItem(KEY, tok);
    }
  } catch (e) {}
  var ultimo = null;
  setInterval(function () {                    // 1 getItem a cada 5s; so manda quando muda
    try {
      var t = sessionStorage.getItem(KEY);
      if (t !== ultimo) { ultimo = t; ipc.send('vperts:token-set', t); }
    } catch (e) {}
  }, 5000);
})();

// ---- cap de fps DINAMICO — instalado ANTES dos scripts do jogo (pega refs capturadas) ----
// main-lite ajusta window.__vpFpsCap por tela: 0 = full · 30 = eco em foco · 12 = eco sem foco
// · 3 = escondida · 1 = modo stats. Depois chama window.__vpKick().
//
// POR QUE NAO E' setTimeout: timer nao sincroniza com o vsync do compositor — os frames
// chegam em tempos irregulares e o olho le isso como TRAVADA (judder), mesmo com o fps
// "certo" no contador. Aqui o rAF REAL continua rodando e a gente so abre um PORTAO uma
// vez por vsync: nao deu o intervalo do cap -> pula o frame (barato) e tenta no proximo.
// Os frames saem alinhados ao vsync = suave. So tela ESCONDIDA (cap <= LOW_CAP) usa timer,
// porque ali o rAF pode ser pausado pelo Chromium e o jogo precisa continuar tickando.
(function () {
  if (window.__vpRAF0) return;                 // ja instalado — nao empilhar wrappers
  var RAF = window.requestAnimationFrame.bind(window);
  var CAF = window.cancelAnimationFrame.bind(window);
  window.__vpRAF0 = RAF; window.__vpCAF0 = CAF;
  if (window.__vpFpsCap == null) window.__vpFpsCap = 0;

  var LOW_CAP = 6;        // <=6fps = tela escondida -> timer (rAF pode estar pausado)
  var TOL = 4;            // ms de tolerancia: casa com o vsync em vez de derivar pra baixo
  // id PROPRIO a partir de 1e9: o Chromium numera rAF/timer a partir de 1, entao esse
  // offset garante que um cancel de id NATIVO nunca acerte um callback nosso por acaso
  var seq = 1e9;
  var live = new Map();   // idProprio -> { to:bool, id, cb }
  var frameT = -1, gate = true, lastPaint = 0;

  // decide UMA vez por vsync se o frame passa: todos os callbacks daquele mesmo vsync
  // compartilham a decisao (senao render e logica do jogo desincronizam)
  function allow (t) {
    var cap = window.__vpFpsCap;
    if (!cap) return true;
    if (t === frameT) return gate;
    frameT = t;
    if (t < lastPaint) lastPaint = t;          // relogio andou pra tras: nao travar o portao
    gate = (t - lastPaint) >= (1000 / cap - TOL);
    if (gate) lastPaint = t;
    return gate;
  }
  function viaTimer (my, cb) {
    var cap = window.__vpFpsCap || 60;
    live.set(my, { to: true, cb: cb, id: setTimeout(function () { live.delete(my); cb(performance.now()); }, 1000 / cap) });
  }

  window.requestAnimationFrame = function (cb) {
    var cap = window.__vpFpsCap;
    if (!cap) return RAF(cb);                  // sem cap (app pago / Eco OFF): caminho direto
    var my = seq++;
    if (cap <= LOW_CAP) { viaTimer(my, cb); return my; }
    var tick = function (t) {
      var c = window.__vpFpsCap;
      if (c && c <= LOW_CAP) { viaTimer(my, cb); return; }   // ficou escondida no meio: migra
      if (!allow(t)) { live.set(my, { to: false, cb: cb, id: RAF(tick) }); return; }
      live.delete(my); cb(t);
    };
    live.set(my, { to: false, cb: cb, id: RAF(tick) });
    return my;
  };
  window.cancelAnimationFrame = function (id) {
    var e = live.get(id);
    if (!e) return CAF(id);                    // id de antes do wrap: repassa
    live.delete(id);
    if (e.to) clearTimeout(e.id); else CAF(e.id);
  };

  // chamado pelo main quando o cap muda: migra os pendentes de rAF pro timer na hora
  // (se a tela acabou de sumir, o rAF pode nunca mais rodar pra fazer isso sozinho)
  window.__vpKick = function () {
    var cap = window.__vpFpsCap;
    if (!cap || cap > LOW_CAP) return;
    live.forEach(function (e, id) { if (e.to) return; CAF(e.id); live.delete(id); viaTimer(id, e.cb); });
  };
})();

(function () {
  console.log('%c[Vperts] bridge (extensao) rodando', 'color:#e5b34f;font-weight:bold');
  const Orig = window.WebSocket;
  // ---- SCHEMA DO WS (docs/WS_SCHEMA.md do AntonioFleck/poke-idle-launcher, MIT — dump real) ----
  // Antes a gente ADIVINHAVA os campos e errava feio:
  //  · `catch-result` NAO tem `shiny` -> o contador de shiny ficava eternamente em 0;
  //  · shiny selvagem e' `field-kill.shiny`; shiny capturado e' `poke-delta.shiny`;
  //  · foto de shiny (Rare Pokemon Picture) e' `profession-photo.pictures` (total do jogo);
  //  · `analyzer` chega pronto a cada ~90s com os MESMOS numeros do painel do jogo;
  //  · o jogo ZERA os contadores ao trocar de hunt (`field-init.huntKey`) — por isso o nosso
  //    "kills" ficava maior que o "Derrotados" da tela.
  const V = {
    msgs: 0, startTs: Date.now(), lastMsgTs: 0, lastKillTs: 0, lastFieldTs: 0, byType: {},
    // sessao: zera na troca de hunt, igual o Hunt Analyzer do jogo (e' o que bate na tela)
    kills: 0, xp: 0, attempts: 0, caught: 0, brokenBalls: 0,
    shinies: 0, shiniesCaught: 0, shinyWild: 0, brokenShiny: 0,
    tot: { kills: 0, xp: 0, caught: 0, brokenBalls: 0, shinies: 0, shiniesCaught: 0, shinyWild: 0 },
    photos: 0,        // Rare Pokemon Picture — 1 foto = 1 shiny achado na hunt
    potions: null, revives: null, rareItems: null,   // estoque real (via /game/items.json)
    hunt: null,       // { slug, key, since } de field-init
    drops: null, lootGold: 0, lootItems: 0,   // loot da sessao valorizado pelo catalogo
    capturesGold: 0, ballsUsed: 0,            // pro saldo (Loot + Capturas - Supply)
    // SUPPLY proprio: o que a sessao gastou em bolas + cura, valorizado pelo catalogo.
    // Antes so existia dentro do `analyzer` do jogo — e o analyzer so chega quando o painel
    // Hunt Analyzer esta ABERTO, entao o saldo do dashboard ficava congelado num snapshot.
    supplyGold: 0, potionsUsed: 0, ballsUsedById: null,
    an: null, anTs: 0,   // analyzer do jogo — guardado so pra conferencia, NAO manda mais no painel
    ballCounts: null, ballCatalog: null,   // catalogo traz nome+icone -> fim do mapa chutado
    lastCatch: null, bestCatch: null, catches: [], rareDrops: [], loot: {},
    offline: false,
  };
  // estado interno (fora do V pra nao ir parar no localStorage a cada save)
  const P = { ids: Object.create(null), shinyOnField: false, lastBall: null, huntKey: null,
    inv: null, items: null, loadingItems: false, lootById: Object.create(null),
    ballIdByName: Object.create(null), curaAntes: null };

  // ---- ESTOQUE de potions/revives ----
  // O proprio jogo publica o catalogo de itens em /game/items.json (id -> nome/categoria/icone;
  // 'heal' = potion, 'revive' = revive). Sem ele a gente lia "10 potions" do texto do Hunt
  // Analyzer — que e' quanto FOI GASTO na sessao, nao o que tem na mochila.
  const loadItems = () => {
    if (P.items || P.loadingItems || typeof fetch !== 'function') return;
    P.loadingItems = true;
    fetch('/game/items.json').then(r => r.json()).then(j => {
      const arr = Array.isArray(j) ? j : (j.items || Object.values(j));
      const map = Object.create(null);
      arr.forEach(it => { if (it && it.id != null) map[it.id] = { name: it.name, category: it.category, rare: !!it.rare, icon: iconUrl(it.icon), price: it.npcPrice || 0 }; });
      P.items = map; bag(); drops(); flush();
    }).catch(() => { P.loadingItems = false; });   // tenta de novo no proximo inventory
  };
  // mesma regra do cliente do jogo: absoluta fica, "/..." ganha o origin, nome cru vira /assets/items/
  const iconUrl = (ic) => !ic ? null
    : /^https?:\/\//.test(ic) ? ic
    : ic.charAt(0) === '/' ? location.origin + ic
    : location.origin + '/assets/items/' + ic;
  // preco de NPC do catalogo do jogo (bolas tambem sao itens do inventario) — base do Supply
  const preco = (id) => (P.items && P.items[id] && P.items[id].price) || 0;
  // sem catalogo -> null (a UI mostra "—"); melhor vazio do que numero errado
  const bag = () => {
    if (!P.inv || !P.items) return;
    let heal = 0, rev = 0; const cura = [], raros = [];
    P.inv.forEach(it => {
      const c = P.items[it.itemId]; const q = it.quantity || 0;
      if (!c || !q) return;
      if (c.category === 'heal' || c.category === 'revive') {
        if (c.category === 'heal') heal += q; else rev += q;
        cura.push({ id: it.itemId, name: c.name, qty: q, icon: c.icon, tipo: c.category });
      }
      if (c.rare || c.category === 'card' || RARE.test(c.name || '')) raros.push({ name: c.name, qty: q });
    });
    // QUAL potion o jogo esta gastando: a que DIMINUIU desde a leitura anterior.
    // O MESMO delta alimenta o Supply da sessao (quantas curas foram queimadas e quanto
    // isso vale) — antes esse numero so existia dentro do analyzer do jogo.
    const antes = P.curaAntes;
    if (antes) cura.forEach(x => {
      const dif = (antes[x.id] != null) ? (antes[x.id] - x.qty) : 0;
      if (dif > 0) { V.usando = x.name; V.potionsUsed += dif; V.supplyGold += dif * preco(x.id); }
    });
    P.curaAntes = {}; cura.forEach(x => { P.curaAntes[x.id] = x.qty; });
    V.potions = heal; V.revives = rev;
    V.cura = cura.sort((a, b) => b.qty - a.qty);        // com nome e icone REAL do jogo
    V.rareItems = raros.sort((a, b) => b.qty - a.qty).slice(0, 12);
  };
  const RARE = /ferom|pheromone|strange|foto|photo|picture/i;
  const addRare = (tag) => { if (V.rareDrops.indexOf(tag) === -1) { V.rareDrops.push(tag); if (V.rareDrops.length > 12) V.rareDrops.shift(); } };
  // DROPS DA SESSAO, como o painel do jogo: sprite + nome + xN + valor. O `analyzer` so
  // chega a cada ~90s, entao ate la a gente soma o loot dos field-kill e valoriza pelo
  // npcPrice do catalogo (marcado como estimativa) — o painel nunca fica vazio.
  const drops = () => {
    const ids = Object.keys(P.lootById);
    if (!P.items || !ids.length) return;
    let gold = 0, itens = 0;
    const lista = ids.map(id => {
      const c = P.items[id] || {}; const qty = P.lootById[id];
      const g = (c.price || 0) * qty; gold += g; itens += qty;
      return { name: c.name || ('item ' + id), qty, icon: c.icon || null, gold: g, rare: !!c.rare };
    }).sort((a, b) => b.gold - a.gold);
    V.drops = lista.slice(0, 14);
    V.lootGold = gold; V.lootItems = itens;
  };
  // BAIXA DA BOLA: o `balls` do jogo nao chega a cada arremesso, entao entre uma mensagem e
  // outra o estoque do painel ficava parado. Aqui a gente desconta na hora a bola usada — o
  // `balls` seguinte, que e' a autoridade, sobrescreve — e ja soma o custo dela no Supply.
  const gastaBola = (m) => {
    let id = (m.ballId != null) ? m.ballId : (m.itemId != null ? m.itemId : null);
    if (id == null && m.ballName) id = P.ballIdByName[String(m.ballName).toLowerCase()];
    if (id == null) return;
    if (V.ballCounts && V.ballCounts[id] != null) V.ballCounts[id] = Math.max(0, V.ballCounts[id] - 1);
    if (!V.ballsUsedById) V.ballsUsedById = Object.create(null);
    V.ballsUsedById[id] = (V.ballsUsedById[id] || 0) + 1;
    V.supplyGold += preco(id);
  };
  // troca de hunt: zera o que o jogo zera. Historico (capturas, melhor, fotos) fica.
  const resetSess = () => {
    V.kills = 0; V.xp = 0; V.attempts = 0; V.caught = 0; V.brokenBalls = 0;
    V.shinies = 0; V.shiniesCaught = 0; V.shinyWild = 0; V.brokenShiny = 0;
    V.loot = {}; V.an = null; V.anTs = 0; V.drops = null; V.lootGold = 0; V.lootItems = 0;
    V.capturesGold = 0; V.ballsUsed = 0;
    V.supplyGold = 0; V.potionsUsed = 0; V.ballsUsedById = null;
    P.lootById = Object.create(null);
  };
  // localStorage.setItem e' SINCRONO: serializar V (ate 200 capturas + loot) a cada punhado
  // de mensagens do WS travava o renderer em rajada de kills. Agora escreve no maximo 1x/s,
  // sempre com o V mais recente (o timer pendente pega o estado da hora que disparar).
  let lastSave = 0, saveT = null;
  const flush = () => { saveT = null; lastSave = Date.now(); try { localStorage.setItem('__vperts', JSON.stringify(V)); } catch(e){} };
  const save = () => { if (saveT) return; saveT = setTimeout(flush, Math.max(0, 1000 - (Date.now() - lastSave))); };
  window.WebSocket = function (url, protos) {
    const ws = protos !== undefined ? new Orig(url, protos) : new Orig(url);
    ws.addEventListener('message', (ev) => {
      const d = ev.data; if (typeof d !== 'string') return; V.msgs++; V.lastMsgTs = Date.now();
      let m; try { m = JSON.parse(d); } catch(e){ return; } const t = m && m.type; if (!t) return;
      V.byType[t] = (V.byType[t]||0)+1;
      switch (t) {
        case 'field-init': {    // comeco/troca de hunt
          const trocou = !!(P.huntKey && m.huntKey && P.huntKey !== m.huntKey);
          if (trocou) resetSess();
          P.huntKey = m.huntKey || P.huntKey;
          // MESMA hunt (reconexao/re-entrada no mapa) mantem o relogio: agora todas as taxas
          // /h saem desse `since`, e reiniciar ele com os contadores cheios estourava o $/h.
          const desde = (!trocou && V.hunt && V.hunt.since) ? V.hunt.since : Date.now();
          V.hunt = { slug: m.slug || null, key: P.huntKey, since: desde };
          V.offline = false;
          break;
        }
        case 'field':
          if (Array.isArray(m.mobs)) {
            P.shinyOnField = m.mobs.some(x => x && x.shiny && !x.dead);
            // campo COM mob = area de caca. Na cidade/mercado nao vem mob nenhum — e' esse
            // carimbo que diz se a conta esta mesmo cacando (o texto da tela mentia).
            if (m.mobs.length) V.lastFieldTs = Date.now();
          }
          break;
        case 'field-kill':
          V.kills++; V.tot.kills++; V.lastKillTs = Date.now();   // prova de que a hunt esta viva
          if (typeof m.xpGained === 'number') { V.xp += m.xpGained; V.tot.xp += m.xpGained; }
          // shiny selvagem derrotado = shiny que ESCAPOU (nao virou seu)
          if (m.shiny) { V.shinyWild++; V.tot.shinyWild++; V.shinies++; V.tot.shinies++; }
          if (Array.isArray(m.loot)) {
            // a lista de drops ja mostra os raros com sprite e valor — nada de tag solta
            m.loot.forEach(it => { if (it && it.itemId != null) P.lootById[it.itemId] = (P.lootById[it.itemId] || 0) + (it.qty || 1); });
            drops();
          }
          break;
        case 'catch-result':
          V.attempts++; V.ballsUsed++;
          if (m.ballName) P.lastBall = m.ballName;
          gastaBola(m);          // baixa a bola no estoque + soma no Supply da sessao
          if (m.success !== true) {
            V.brokenBalls++; V.tot.brokenBalls++;
            if (P.shinyOnField) V.brokenShiny++;      // ball gasta COM shiny na tela
          }
          break;
        case 'poke-delta': {    // poke novo na colecao = captura (o jogo tambem manda update)
          const p = m.poke; if (!p) break;
          const known = P.ids[p.id] || p.team === true || p.leader === true;
          P.ids[p.id] = 1;
          if (known) break;                            // so atualizou um poke meu
          V.caught++; V.tot.caught++;
          V.capturesGold += (p.sellValue || 0);        // entra no saldo, como no painel do jogo
          if (p.shiny) { V.shiniesCaught++; V.tot.shiniesCaught++; V.shinies++; V.tot.shinies++; }
          V.lastCatch = { name:p.name, quality:p.quality, ivTotal:p.ivTotal, power:p.power, shiny:!!p.shiny, sellValue:p.sellValue, ball:P.lastBall };
          V.catches.push({ name:p.name, quality:p.quality, ivTotal:p.ivTotal, shiny:!!p.shiny });
          if (V.catches.length > 200) V.catches.shift();
          if (!V.bestCatch || (p.quality||0) > (V.bestCatch.quality||0)) V.bestCatch = { name:p.name, quality:p.quality, ivTotal:p.ivTotal };
          break;
        }
        case 'profession-photo':  // fotografou shiny na hunt: `pictures` = total (autoridade)
          if (m.pictures != null) V.photos = m.pictures;
          else if (m.ok) V.photos++;
          if (m.ok) addRare('📸 Foto de shiny');
          break;
        case 'analyzer':          // stats OFICIAIS da sessao (~90s) — mesmos numeros do painel
          V.an = { kills:m.kills, seconds:m.seconds, xp:m.xpGained, lootGold:m.lootGold, lootItems:m.lootItems,
            ballsUsed:m.ballsUsed, potionsUsed:m.potionsUsed, captures:m.captures, shinyCaptures:m.shinyCaptures,
            capturesGold:m.capturesGold, supplyGold:m.supplyGold, balance:m.balance,
            goldPerHour:m.goldPerHour, xpPerHour:m.xpPerHour, killsPerHour:m.killsPerHour, drops:m.drops || [] };
          V.anTs = Date.now();    // carimbo: sem isso nao da pra saber que o snapshot envelheceu
          break;
        case 'balls':
          // MERGE, nao substitui. O jogo manda `counts` so com a(s) bola(s) que mudaram —
          // trocar o mapa inteiro por essa mensagem APAGAVA os outros tipos do painel
          // (por isso "falta uma ball na lista" e o total nao batia com o HUD do jogo).
          if (m.counts) V.ballCounts = Object.assign(V.ballCounts || Object.create(null), m.counts);
          if (m.catalog) {
            V.ballCatalog = m.catalog;                 // id -> nome/icone reais
            m.catalog.forEach(b => { if (b && b.id != null && b.name) P.ballIdByName[String(b.name).toLowerCase()] = b.id; });
          }
          break;
        case 'pokes': {   // time da conta: o LIDER vira a arte do painel (sprite pela dex)
          const lista = Array.isArray(m.list) ? m.list : [];
          const lead = lista.find(p => p && p.leader) || lista.find(p => p && p.team) || null;
          if (lead) V.lider = { name: lead.name, speciesId: lead.speciesId, level: lead.level,
            shiny: !!lead.shiny, hp: lead.hp, maxHp: lead.maxHp, quality: lead.quality, ivTotal: lead.ivTotal };
          break;
        }
        case 'inventory':                              // mochila: base do estoque real
          P.inv = m.items || null;
          loadItems(); bag();
          break;
        case 'session-replaced':  // logou em outro lugar: essa aba caiu
          V.offline = true;
          break;
      }
      save();
    });
    return ws;
  };
  window.WebSocket.prototype = Orig.prototype;
  ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(k => window.WebSocket[k] = Orig[k]);
  flush();
})();