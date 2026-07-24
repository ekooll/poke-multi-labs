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
    // HP/XP/level do LIDER em TEMPO REAL (card estilo jogo). NAO zeram na troca de hunt (o
    // pokemon e o mesmo). HP vem do `field` (~3,5x/s); xp/level do `poke-xp` (a cada kill).
    heroHp: null, heroMaxHp: null, heroFainted: false,
    liderXp: null, liderLevel: null,
    // curva de XP APRENDIDA nos level-ups: nivel -> xp cumulativo pra alcancar. O servidor nao
    // manda "xp pro proximo" e o cliente nao tem a formula (descoberto 23/07), entao a barra
    // aprende sozinha: ao subir de nivel, o xp daquele instante e' ~o limiar do novo nivel.
    xpThresholds: Object.create(null),
    drops: null, lootGold: 0, lootItems: 0,   // loot da sessao valorizado pelo catalogo
    lootById: Object.create(null),            // id -> qtd; MORA no V pra sobreviver a reload
    lootBruto: 0, itensBruto: 0,              // soma crua do catalogo (antes do ajuste)
    lootAjuste: 0, itensAjuste: 0,            // delta que a reconciliacao com o analyzer deixou
    capturesGold: 0, ballsUsed: 0,            // pro saldo (Loot + Capturas - Supply)
    // FOTO DE SHINY separada do loot: o painel do jogo NAO conta ela no "Loot", mas conta no
    // "Saldo" (medido 23/07: Saldo - Loot - Capturas + Supply = valor exato das fotos). E ela
    // e o UNICO item cujo preco no painel nao e o npcPrice do items.json: 5.000 no catalogo,
    // ~57.873 na tela — e' preco de MERCADO, que muda de dia pra dia (51.877 em 22/07).
    fotoGold: 0, fotosSess: 0, fotoPreco: 0,
    // SUPPLY proprio: o que a sessao gastou em bolas + cura, valorizado pelo catalogo.
    // Antes so existia dentro do `analyzer` do jogo — e o analyzer so chega quando o painel
    // Hunt Analyzer esta ABERTO, entao o saldo do dashboard ficava congelado num snapshot.
    supplyGold: 0, potionsUsed: 0, revivesUsed: 0, ballsUsedById: null,
    an: null, anTs: 0,   // analyzer do jogo — guardado so pra conferencia, NAO manda mais no painel
    // marco da sessao: `catches` guarda o HISTORICO (o dashboard vive dele), entao o card
    // filtra por aqui pra so contar as capturas DESTA sessao. Sem isso a lixeira zerava
    // Derrotados/Profit e deixava "LENDARIA+ 1" e a faixa da ultima captura na tela.
    sessTs: Date.now(),
    // baseline do analyzer no reset manual: o jogo nao zera junto, entao sem isso a proxima
    // mensagem `analyzer` ressuscitava tudo ~90s depois de clicar na lixeira.
    // ancora: nosso valor no instante em que a sessao do painel do jogo comecou. Ver o case
    // 'analyzer'. `1` = re-ancorar no proximo analyzer (usado pela lixeira do card).
    ancora: null,
    ballCounts: null, ballCatalog: null,   // catalogo traz nome+icone -> fim do mapa chutado
    lastCatch: null, bestCatch: null, catches: [], rareDrops: [], loot: {},
    offline: false,
  };
  // estado interno (fora do V pra nao ir parar no localStorage a cada save)
  const P = { ids: Object.create(null), shinyOnField: false, lastBall: null, huntKey: null,
    inv: null, items: null, loadingItems: false,   // lootById saiu daqui: agora mora no V (persiste)
    ballIdByName: Object.create(null), curaAntes: null,
    pokesSync: 0,           // 1 = ja sincronizamos a colecao (a 1a lista nao conta captura)
    esperandoCaptura: 0 };  // quantas capturas o catch-result anunciou e ainda nao casamos

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
      // price = npcPrice (o que o item VALE quando dropa) · buy = priceGold (o que CUSTA na loja).
      // Os dois existem no mesmo json e sao MUITO diferentes: Ultra Potion vale 400 e custa 22.
      arr.forEach(it => { if (it && it.id != null) map[it.id] = { name: it.name, category: it.category, rare: !!it.rare, icon: iconUrl(it.icon), price: it.npcPrice || 0, buy: it.priceGold || 0 }; });
      P.items = map; bag(); drops(); flush();
    }).catch(() => { P.loadingItems = false; });   // tenta de novo no proximo inventory
  };
  // mesma regra do cliente do jogo: absoluta fica, "/..." ganha o origin, nome cru vira /assets/items/
  const iconUrl = (ic) => !ic ? null
    : /^https?:\/\//.test(ic) ? ic
    : ic.charAt(0) === '/' ? location.origin + ic
    : location.origin + '/assets/items/' + ic;
  // preco de NPC do catalogo do jogo (/game/items.json) — usado no LOOT
  const preco = (id) => (P.items && P.items[id] && P.items[id].price) || 0;
  // PRECO DE COMPRA (priceGold) — usado no SUPPLY. MEDIDO 23/07/2026: o Hunt Analyzer cobra a
  // cura pelo que ela CUSTA, nao pelo que ela vale. Prova exata no painel do ekoo_03: 963 bolas
  // x 130 = 125.190, Supply = 125.894 -> sobram 704 / 32 potions = 22,0 = priceGold da Ultra
  // Potion (o npcPrice dela e 400 — 18x a mais). Usar preco() aqui derrubava o Profit de quem
  // gasta cura: o ekoo_02 (788 potions em 5h27m) aparecia NEGATIVO com o jogo em +570k.
  const precoCompra = (id) => (P.items && P.items[id] && P.items[id].buy) || 0;
  // PRECO DA BOLA: sai do catalogo que vem na msg `balls` (priceGold), NAO do items.json.
  // MEDIDO em 22/07/2026: as bolas nao existem no items.json (categorias: card, clan, heal,
  // loot, revive, stone, tm) e usam ids 1..4, que COLIDEM com ids de itens de la — o Supply
  // acabava somando o npcPrice de um item qualquer (~$40) em vez dos $130 da Ultra Ball.
  // Prova: o Hunt Analyzer marcou Supply -$5.590 com 43 bolas = exatamente 130 cada.
  const precoBola = (id) => {
    const c = V.ballCatalog; if (!c) return 0;
    for (const k in c) { const b = c[k]; if (b && b.id === id) return b.priceGold || 0; }
    return 0;
  };
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
      if (dif > 0) {
        V.usando = x.name;
        if (x.tipo === 'revive') V.revivesUsed += dif; else V.potionsUsed += dif;
        V.supplyGold += dif * precoCompra(x.id);   // preco de COMPRA, igual o painel do jogo
      }
    });
    P.curaAntes = {}; cura.forEach(x => { P.curaAntes[x.id] = x.qty; });
    V.potions = heal; V.revives = rev;
    V.cura = cura.sort((a, b) => b.qty - a.qty);        // com nome e icone REAL do jogo
    V.rareItems = raros.sort((a, b) => b.qty - a.qty).slice(0, 12);
  };
  // id do "Rare Pokémon Picture" no catalogo do jogo. Procura pelo NOME (id pode mudar em
  // atualizacao) e so cai no 59195 conhecido se o catalogo ainda nao tiver carregado.
  const idDaFoto = () => {
    if (P.items) for (const k in P.items) {
      if (/rare\s*pok.?mon\s*picture/i.test(P.items[k].name || '')) return +k;
    }
    return 59195;
  };
  // COTACAO DA FOTO. A Rare Pokemon Picture e' o UNICO drop que o painel do jogo nao avalia
  // pelo npcPrice do items.json: la ela vale 5.000, na tela vale o preco de MERCADO — 57.873 em
  // 23/07 e 51.877 em 22/07 (flutua). Nao existe fonte independente: /game/market.json e
  // companhia dao 404 e o WS nao tem mensagem de mercado (conferido nos 21 tipos que chegam).
  // Entao: aprendemos a cotacao toda vez que o painel esta aberto (V.fotoPreco, que SOBREVIVE
  // a troca de hunt e a reload) e, enquanto nunca tivermos aprendido, usamos a ultima medicao
  // conhecida em vez do piso do catalogo. Errar por 10% de flutuacao e' muito melhor do que
  // errar 11x pra baixo: com o painel fechado, cada foto sumia com ~52.900 do Profit.
  const FOTO_MERCADO_MEDIDO = 57873;   // medido no painel em 23/07/2026 (115.746 / 2 fotos)
  const precoDaFoto = () => V.fotoPreco || FOTO_MERCADO_MEDIDO || preco(idDaFoto()) || 0;
  // VALOR DA FOTO E' DERIVADO, nunca guardado. Antes existiam DOIS campos que precisavam andar
  // juntos (`fotosSess` contador e `fotoGold` valor) e eles dessincronizaram de verdade: em
  // 23/07 o card exibiu "Rare Pokemon Picture x2 -> $0", um item raro parecendo nao valer nada.
  // Com o valor derivado do contador nao existe estado pra dessincronizar — o bug some por
  // construcao, nao por vigilancia.
  const fotoValor = () => (V.fotosSess || 0) * precoDaFoto();
  const RARE = /ferom|pheromone|strange|foto|photo|picture/i;
  const addRare = (tag) => { if (V.rareDrops.indexOf(tag) === -1) { V.rareDrops.push(tag); if (V.rareDrops.length > 12) V.rareDrops.shift(); } };
  // DROPS DA SESSAO, como o painel do jogo: sprite + nome + xN + valor. O `analyzer` so
  // chega a cada ~90s, entao ate la a gente soma o loot dos field-kill e valoriza pelo
  // npcPrice do catalogo (marcado como estimativa) — o painel nunca fica vazio.
  const drops = () => {
    const ids = Object.keys(V.lootById);
    if (!P.items || (!ids.length && !V.fotosSess)) return;
    let gold = 0, itens = 0;
    const lista = ids.map(id => {
      const c = P.items[id] || {}; const qty = V.lootById[id];
      const g = (c.price || 0) * qty; gold += g; itens += qty;
      return { name: c.name || ('item ' + id), qty, icon: c.icon || null, gold: g, rare: !!c.rare };
    });
    // a foto aparece na lista (igual no painel do jogo) mas com o preco de MERCADO e FORA do
    // lootGold — senao a nossa linha "Loot" nunca fecharia com a do jogo, que a exclui.
    if (V.fotosSess > 0) {
      const fid = idDaFoto(), fc = (P.items && P.items[fid]) || {};
      lista.push({ name: fc.name || 'Rare Pokémon Picture', qty: V.fotosSess,
        icon: fc.icon || null, gold: fotoValor(), rare: true });
    }
    V.fotoGold = fotoValor();   // publicado pra UI (cdp/card), sempre derivado do contador
    lista.sort((a, b) => b.gold - a.gold);
    V.drops = lista.slice(0, 14);
    // `lootBruto` = a soma crua do catalogo. O loot exibido e' ela + o AJUSTE que a
    // reconciliacao com o analyzer deixou. Sem esse ajuste, o primeiro field-kill depois de
    // um `analyzer` recalculava o loot do zero e jogava fora o numero oficial do jogo (kills,
    // supply e capturas nao sofrem: aqueles sao incrementais).
    V.lootBruto = gold; V.itensBruto = itens;
    V.lootGold = gold + (V.lootAjuste || 0);
    V.lootItems = itens + (V.itensAjuste || 0);
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
    V.supplyGold += precoBola(id);   // priceGold da msg `balls`, nao npcPrice do items.json
  };
  // ---- RELOGIO DA HUNT ----
  // O `since` so nascia no field-init, entao o contador do card seguia correndo com a conta
  // parada na cidade e nunca zerava. Aqui: se o ultimo sinal de hunt (mob no campo ou kill)
  // foi ha mais de 60s, quem chega agora e' RE-ENTRADA -> o relogio comeca do zero.
  // 60s e' o mesmo limiar que o cdp usa pra pintar a bolinha, pra as duas nunca discordarem.
  // ...MAS so quando nao ha sessao acumulada. Zerar o relogio com os contadores cheios fazia o
  // card mostrar 1.210 kills num cronometro de 5s (e o $/h estourava). O jogo nao para de
  // contar "Tempo na hunt" porque voce deu uma passada no mercado — a gente tambem nao para.
  const FORA_MS = 60000;
  const marcaAtividadeHunt = () => {
    const agora = Date.now();
    const ult = Math.max(V.lastFieldTs || 0, V.lastKillTs || 0);
    if (V.hunt && ult && !V.kills && (agora - ult) > FORA_MS) V.hunt.since = agora;
  };
  // troca de hunt: zera o que o jogo zera. Historico (capturas, melhor, fotos) fica.
  const resetSess = () => {
    V.kills = 0; V.xp = 0; V.attempts = 0; V.caught = 0; V.brokenBalls = 0;
    V.shinies = 0; V.shiniesCaught = 0; V.shinyWild = 0; V.brokenShiny = 0;
    V.loot = {}; V.an = null; V.anTs = 0; V.anSync = 0; V.drops = null; V.lootGold = 0; V.lootItems = 0;
    V.lootBruto = 0; V.itensBruto = 0; V.lootAjuste = 0; V.itensAjuste = 0;
    V.capturesGold = 0; V.ballsUsed = 0;
    V.supplyGold = 0; V.potionsUsed = 0; V.revivesUsed = 0; V.ballsUsedById = null;
    V.fotoGold = 0; V.fotosSess = 0;      // fotoPreco NAO zera: e' cotacao, nao contador
    V.lootById = Object.create(null);
    V.lastCatch = null; V.sessTs = Date.now(); V.ancora = 1;   // 1 = re-ancorar no proximo analyzer
    V.deriva = null; V.derivas = []; V.derivaLonga = null;   // deriva e' medida POR sessao
  };
  // localStorage.setItem e' SINCRONO: serializar V (ate 200 capturas + loot) a cada punhado
  // de mensagens do WS travava o renderer em rajada de kills. Agora escreve no maximo 1x/s,
  // sempre com o V mais recente (o timer pendente pega o estado da hora que disparar).
  let lastSave = 0, saveT = null;
  const flush = () => { saveT = null; lastSave = Date.now(); try { localStorage.setItem('__vperts', JSON.stringify(V)); } catch(e){} };
  const save = () => { if (saveT) return; saveT = setTimeout(flush, Math.max(0, 1000 - (Date.now() - lastSave))); };
  // HP/XP do lider numa chave PEQUENA e SEPARADA, escrita a CADA mensagem (fora do debounce de
  // 1s do `save`). Serializar o V inteiro 1x/s trava o renderer; este objeto tem 5 numeros, e'
  // barato. E' o que deixa a barra de HP acompanhar a batalha (~3,5x/s) em vez de pular 1x/s.
  const salvaHero = () => { try { localStorage.setItem('__vpHero',
    JSON.stringify({ hp: V.heroHp, mx: V.heroMaxHp, ko: V.heroFainted, xp: V.liderXp, lvl: V.liderLevel, t: Date.now() })); } catch(e){} };
  // Reset manual (botao de lixeira do card): zera EXATAMENTE o que a troca de hunt zera,
  // sem precisar esperar o field-init. Historico (capturas, fotos, melhor) fica de pe.
  // Grava na hora - se o app fechasse antes do save de 1s, o reset se perdia.
  // `ancora = 1` = re-ancorar no proximo `analyzer`: ele mede a distancia entre o painel do
  // jogo (que segue correndo) e o nosso zero, e a partir dali soma so o que vier depois.
  window.__vpReset = () => { resetSess(); V.ancora = 1; flush(); return true; };

  // ---- RESTAURA A SESSAO ----
  // O `__vperts` era SO ESCRITA: ninguem relia no boot, entao todo F5, reconexao ou reabrir o
  // app zerava o card enquanto o painel do jogo (que vive no servidor) seguia contando. Agora
  // o estado volta do localStorage antes da primeira mensagem do WS.
  //
  // O que NAO volta e de proposito: `P.ids` (colecao) e `P.curaAntes` (estoque de cura). Os
  // dois sao base de comparacao, e restaura-los seria pior que zerar — a 1a lista `pokes`
  // depois do reload entraria inteira como "capturei agora" e o 1o `inventory` marcaria como
  // consumo qualquer diferenca acumulada offline. Zerados, a primeira leitura so vira baseline.
  (function restaura () {
    // catalogo JA no boot, fora de qualquer condicao: antes ele so era buscado quando chegava
    // um `inventory`, entao ate a mochila do jogo aparecer o drops() saia cedo e o loot ficava
    // ZERADO (pego pelo harness: 123 kills com drop e lootGold = 0).
    loadItems();
    let s = null;
    try { s = JSON.parse(localStorage.getItem('__vperts') || 'null'); } catch (e) { return; }
    if (!s || typeof s !== 'object') return;
    const num = ['kills','xp','attempts','caught','brokenBalls','shinies','shiniesCaught','shinyWild',
      'brokenShiny','photos','lootGold','lootItems','capturesGold','ballsUsed','supplyGold',
      'potionsUsed','revivesUsed','fotoGold','fotosSess','fotoPreco','anTs','anSync','sessTs',
      'lootBruto','itensBruto','lootAjuste','itensAjuste','fotoPrecoTs',
      'heroHp','heroMaxHp','liderXp','liderLevel',
      'lastKillTs','lastFieldTs','lastMsgTs','msgs'];
    num.forEach(k => { if (typeof s[k] === 'number' && isFinite(s[k])) V[k] = s[k]; });
    if (s.tot && typeof s.tot === 'object') Object.keys(V.tot).forEach(k => { if (typeof s.tot[k] === 'number') V.tot[k] = s.tot[k]; });
    if (s.hunt && s.hunt.since) V.hunt = { slug: s.hunt.slug || null, key: s.hunt.key || null, since: s.hunt.since };
    if (s.lootById && typeof s.lootById === 'object') V.lootById = Object.assign(Object.create(null), s.lootById);
    if (s.ballsUsedById) V.ballsUsedById = Object.assign(Object.create(null), s.ballsUsedById);
    // curva de XP APRENDIDA: conhecimento acumulado — tem que sobreviver a reload/restart,
    // senao a barra reaprende do zero toda vez. (limiares por nivel; cresce devagar, e' pequeno)
    if (s.xpThresholds && typeof s.xpThresholds === 'object') V.xpThresholds = Object.assign(Object.create(null), s.xpThresholds);
    if (Array.isArray(s.catches)) V.catches = s.catches.slice(-200);
    if (Array.isArray(s.rareDrops)) V.rareDrops = s.rareDrops.slice(-12);
    ['an','drops','bestCatch','lastCatch','lider','huntMob','ballCounts','ballCatalog','loot','byType','usando','ancora','deriva','derivas','derivaLonga']
      .forEach(k => { if (s[k] != null) V[k] = s[k]; });
    // A ancora vale pra UMA sessao do painel do jogo. Depois de um reload, a sessao dele
    // comeca de novo do zero — entao a ancora velha nao descreve mais nada e o primeiro
    // `analyzer` tem que medir a distancia outra vez. Guardar a antiga aqui era o caminho pro
    // "seconds: -4111" que dava 1h08 de brinde no cronometro.
    // `null` (nao `1`): re-ancorar AUTOMATICO, que nunca joga dado fora. `1` e' reservado pra
    // lixeira — usar ele aqui faria todo reload descontar o que o painel do jogo ja tinha.
    V.ancora = null;
    // o valor da foto e' derivado do contador: recalcula ja no boot pra nunca voltar
    // dessincronizado do que foi gravado por uma versao anterior
    V.fotoGold = (V.fotosSess || 0) * (V.fotoPreco || FOTO_MERCADO_MEDIDO);
    P.huntKey = (s.hunt && s.hunt.key) || null;
    // o mapa nome->id da bola vem do catalogo; sem reconstruir, o `gastaBola` perderia a baixa
    // ate a proxima msg `balls` chegar
    if (Array.isArray(V.ballCatalog)) V.ballCatalog.forEach(b => { if (b && b.id != null && b.name) P.ballIdByName[String(b.name).toLowerCase()] = b.id; });
    V.offline = false;
  })();
  window.WebSocket = function (url, protos) {
    const ws = protos !== undefined ? new Orig(url, protos) : new Orig(url);
    ws.addEventListener('message', (ev) => {
      const d = ev.data; if (typeof d !== 'string') return; V.msgs++; V.lastMsgTs = Date.now();
      let m; try { m = JSON.parse(d); } catch(e){ return; } const t = m && m.type; if (!t) return;
      V.byType[t] = (V.byType[t]||0)+1;
      switch (t) {
        case 'field-init': {    // comeco/troca de hunt
          // TROCA DE HUNT E' PELO `slug`, NAO PELO `huntKey`. MEDIDO 23/07/2026: re-entrar na
          // MESMA hunt gera um huntKey novo, e o Hunt Analyzer do jogo NAO zera nessa hora.
          // Prova no comparacao.csv: as 00:58 card e jogo zeraram juntos (-843 nos dois =
          // troca real); as 04:48 so o card zerou (2.849 -> 19) porque o huntKey mudou numa
          // re-entrada — e a partir dali a diferenca travou em -812.426 pra sempre. Era ESSA
          // a causa do card marcar 1h37m/1.210 com o painel do jogo em 5h27m/4.040.
          const antesSlug = V.hunt && V.hunt.slug;
          const trocou = !!(antesSlug && m.slug && antesSlug !== m.slug);
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
          // HP do lider AO VIVO — a barra do card acompanha a batalha em tempo real. Antes o HP
          // vinha do `pokes` (raro) e ficava defasado. `heroHp`/`heroMaxHp` chegam ~3,5x/s.
          if (typeof m.heroHp === 'number') V.heroHp = m.heroHp;
          if (typeof m.heroMaxHp === 'number') V.heroMaxHp = m.heroMaxHp;
          if (m.fainted != null) V.heroFainted = !!m.fainted;
          salvaHero();   // grava o HP na chave rapida a cada field (~3,5x/s) — barra fluida
          if (Array.isArray(m.mobs)) {
            P.shinyOnField = m.mobs.some(x => x && x.shiny && !x.dead);
            // campo COM mob = area de caca. Na cidade/mercado nao vem mob nenhum — e' esse
            // carimbo que diz se a conta esta mesmo cacando (o texto da tela mentia).
            if (m.mobs.length) { marcaAtividadeHunt(); V.lastFieldTs = Date.now(); }
            // POKEMON DA HUNT: o mob da tela vira o icone do card. MEDIDO no WS (22/07): o mob
            // NAO tem `name` - vem { row, col, facing, slot, speciesId, hp, maxHp, dead,
            // respawning, shiny }. Por isso a chave e o speciesId, e o nome sai do slug.
            // Conta o mais frequente (nao o primeiro) pra nao trocar de cara a cada respawn.
            // Mobs mortos entram na conta: durante o respawn TODOS ficam dead e o icone sumiria.
            const cont = Object.create(null); let topo = null, topoN = 0;
            for (const x of m.mobs) {
              if (!x || x.speciesId == null) continue;
              const k = x.speciesId; cont[k] = (cont[k] || 0) + 1;
              if (cont[k] > topoN) { topoN = cont[k]; topo = x; }
            }
            if (topo) V.huntMob = { speciesId: topo.speciesId, shiny: !!topo.shiny,
              nome: (V.hunt && V.hunt.slug) ? V.hunt.slug.replace(/_/g, ' ') : null };
          }
          break;
        case 'field-kill':
          marcaAtividadeHunt();                                  // voltou depois de sair? relogio do zero
          V.kills++; V.tot.kills++; V.lastKillTs = Date.now();   // prova de que a hunt esta viva
          if (typeof m.xpGained === 'number') { V.xp += m.xpGained; V.tot.xp += m.xpGained; }
          // shiny selvagem derrotado = shiny que ESCAPOU (nao virou seu)
          if (m.shiny) { V.shinyWild++; V.tot.shinyWild++; V.shinies++; V.tot.shinies++; }
          if (Array.isArray(m.loot)) {
            // a lista de drops ja mostra os raros com sprite e valor — nada de tag solta
            m.loot.forEach(it => { if (it && it.itemId != null) V.lootById[it.itemId] = (V.lootById[it.itemId] || 0) + (it.qty || 1); });
            drops();
          }
          break;
        case 'poke-xp': {   // XP/level do LIDER em tempo real (card estilo jogo)
          // `xp` e' CUMULATIVO. Ao SUBIR de nivel, o xp daquele instante e' ~o limiar do novo
          // nivel — e' assim que a barra aprende a curva (o servidor nao manda "xp pro proximo"
          // e o cliente nao tem a formula). Guarda por NIVEL; a % sai de limiar[n] e limiar[n+1].
          if (typeof m.level === 'number' && typeof m.xp === 'number') {
            if (V.liderLevel != null && m.level > V.liderLevel) {
              // subiu de nivel: registra o limiar de CADA nivel cruzado (normalmente 1)
              V.xpThresholds[m.level] = m.xp;
            }
            V.liderLevel = m.level;
            V.liderXp = m.xp;
            salvaHero();   // xp/level na chave rapida tambem
          }
          break;
        }
        case 'catch-result':
          V.attempts++; V.ballsUsed++;
          if (m.ballName) P.lastBall = m.ballName;
          gastaBola(m);          // baixa a bola no estoque + soma no Supply da sessao
          if (m.success !== true) {
            V.brokenBalls++; V.tot.brokenBalls++;
            if (P.shinyOnField) V.brokenShiny++;      // ball gasta COM shiny na tela
          } else {
            // capturou: o bicho chega na PROXIMA lista `pokes`. Este contador e o portao —
            // sem ele, lista de market/depot viraria captura. Ver o case 'pokes'.
            P.esperandoCaptura = (P.esperandoCaptura || 0) + 1;
          }
          break;
        case 'poke-delta': {    // poke novo na colecao = captura (o jogo tambem manda update)
          const p = m.poke; if (!p) break;
          const known = P.ids[p.id] || p.team === true || p.leader === true;
          P.ids[p.id] = 1;
          if (known) break;                            // so atualizou um poke meu
          // MESMO PORTAO do case 'pokes': so conta se o jogo anunciou uma captura ha pouco.
          // Poke novo tambem chega por choco de ovo, copia de Ditto, troca e evento — e o
          // proprio jogo passou a NAO marcar esses como "capturado" (patch de 23/07/2026:
          // "Capturado agora significa CAPTURADO"). Sem o portao, o card contava ovo como
          // captura e ainda somava o sellValue dele no saldo da hunt.
          if (!P.esperandoCaptura) break;
          P.esperandoCaptura--;
          V.caught++; V.tot.caught++;
          V.capturesGold += (p.sellValue || 0);        // entra no saldo, como no painel do jogo
          if (p.shiny) { V.shiniesCaught++; V.tot.shiniesCaught++; V.shinies++; V.tot.shinies++; }
          V.lastCatch = { name:p.name, quality:p.quality, ivTotal:p.ivTotal, power:p.power, shiny:!!p.shiny, sellValue:p.sellValue, ball:P.lastBall };
          // speciesId junto: e ele que permite mostrar o SPRITE da captura (card e dashboard).
          // Capturas ja gravadas antes desta versao nao tem o campo - quem exibe cai no icone
          // generico, entao nao quebra nada.
          // `ts`: e por ele que o card sabe o que e' DESTA sessao (a lista e historico e nao
          // zera na troca de hunt — o dashboard vive dela). Captura antiga sem ts = antes.
          V.catches.push({ name:p.name, quality:p.quality, ivTotal:p.ivTotal, shiny:!!p.shiny, speciesId:p.speciesId, ts:Date.now() });
          if (V.catches.length > 200) V.catches.shift();
          if (!V.bestCatch || (p.quality||0) > (V.bestCatch.quality||0)) V.bestCatch = { name:p.name, quality:p.quality, ivTotal:p.ivTotal };
          break;
        }
        case 'profession-photo': {  // fotografou shiny na hunt: `pictures` = total (autoridade)
          const antes = V.photos || 0;
          if (m.pictures != null) V.photos = m.pictures;
          else if (m.ok) V.photos++;
          // A FOTO E UM ITEM DE LOOT e entra no Saldo do jogo, mas NAO chega em
          // field-kill.loot — vem so por aqui. Sem isso o Profit ignorava a foto: no teste
          // de 22/07 o jogo marcou Saldo +54.079 (4.162 de loot - 1.960 de supply + 51.877
          // da foto) enquanto o card mostrava +1.588. Somando como item, ela tambem aparece
          // na lista de drops da sessao, igual no painel do jogo.
          const ganhou = (m.pictures != null) ? (V.photos > antes) : !!m.ok;
          if (ganhou) {
            V.fotosSess++; V.fotoGold = fotoValor(); drops();
          }
          if (m.ok) addRare('📸 Foto de shiny');
          break;
        }
        case 'analyzer': {        // stats OFICIAIS da sessao (~90s) — mesmos numeros do painel
          // O JOGO ZEROU A SESSAO DELE? kills/seconds voltando pra tras so acontece nisso
          // (troca de hunt, relogin, reabrir o app). Ai a gente zera junto — e joga fora
          // qualquer marco zero velho. MEDIDO no boot de 23/07: o app subiu com a sessao de 1h
          // restaurada e o analyzer chegou zerado; sem isso o marco saia `seconds: -3538` e o
          // cronometro do card ganhava 59 minutos de presente.
          const anAntes = V.an;
          // O painel do jogo VOLTOU PRA TRAS. MEDIDO em 23/07/2026, e essa medicao derrubou uma
          // premissa: o Hunt Analyzer **so conta enquanto o painel dele esta ABERTO**. Ao reabrir,
          // ele comeca do ZERO (chegou `kills:0, seconds:0` em duas contas e `159/763s` na que
          // fora aberta 12 min antes). Ou seja, ele NAO e' um rastreador de sessao — e' um
          // "desde que voce abriu". A versao anterior tratava isso como "o jogo zerou a hunt" e
          // chamava resetSess(): abrir o painel APAGAVA a sessao do dono (perdemos 583, 556 e
          // 1.223 kills de verdade nesse dia). Agora a volta pra tras so RE-ANCORA.
          const voltouPraTras = !!(anAntes && ((typeof m.kills === 'number' && m.kills < (anAntes.kills || 0)) ||
                          (typeof m.seconds === 'number' && m.seconds + 5 < (anAntes.seconds || 0))));
          V.an = { kills:m.kills, seconds:m.seconds, xp:m.xpGained, lootGold:m.lootGold, lootItems:m.lootItems,
            ballsUsed:m.ballsUsed, potionsUsed:m.potionsUsed, captures:m.captures, shinyCaptures:m.shinyCaptures,
            capturesGold:m.capturesGold, supplyGold:m.supplyGold, balance:m.balance,
            goldPerHour:m.goldPerHour, xpPerHour:m.xpPerHour, killsPerHour:m.killsPerHour, drops:m.drops || [] };
          V.anTs = Date.now();    // carimbo: sem isso nao da pra saber que o snapshot envelheceu
          // ---- ANCORA (substituiu o "carimbo") ----
          // O analyzer NAO e' a verdade sobre a NOSSA sessao: ele so enxerga o pedaco que
          // aconteceu com o painel aberto. Tratar o numero dele como autoridade era o que
          // apagava o card. O modelo certo e' de SOMA:
          //
          //     nosso_valor = ancora + valor_do_painel
          //
          // onde `ancora` = o que a gente ja tinha no instante em que a sessao DELE comecou.
          // Isso cobre os tres casos com uma regra so:
          //   · painel reaberto (painel em 0, nos com 1.223) -> ancora = 1.223, seguimos somando
          //   · lixeira do card (nos em 0, painel com 900)   -> ancora = -900, so conta o novo
          //   · painel aberto o tempo todo                   -> ancora ~ 0, igual ao de antes
          // O UNICO sinal de "zerou de verdade" continua sendo `field-init` com slug diferente.
          const n = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
          const pos = (v) => v > 0 ? v : 0;
          const manual = V.ancora === 1;   // lixeira do card: o dono MANDOU zerar
          const precisaAncorar = manual || voltouPraTras || !V.ancora || typeof V.ancora !== 'object';
          if (precisaAncorar) {
            // Ancora automatica NUNCA e' negativa: negativa significaria jogar fora o que o
            // painel do jogo sabe e a gente ainda nao. Entao o card sempre fica com a MAIOR das
            // duas visoes — se ele abriu o app no meio de uma hunt e o painel do jogo ja tinha
            // 900 kills, esses 900 sao a verdade mais proxima e a gente adota.
            // A lixeira e' a unica excecao: ali o dono pediu zero, entao a ancora pode ser
            // negativa pra descontar o que o painel ja acumulou.
            const dif = (nosso, dele) => { const d = (nosso || 0) - (n(dele) || 0); return manual ? d : Math.max(0, d); };
            V.ancora = { kills: dif(V.kills, m.kills), xp: dif(V.xp, m.xpGained),
              lootGold: dif(V.lootGold, m.lootGold), lootItems: dif(V.lootItems, m.lootItems),
              capturesGold: dif(V.capturesGold, m.capturesGold), supplyGold: dif(V.supplyGold, m.supplyGold),
              captures: dif(V.caught, m.captures), ballsUsed: dif(V.ballsUsed, m.ballsUsed),
              potionsUsed: dif(V.potionsUsed, m.potionsUsed) };
          }
          const A = V.ancora;
          const base = (k) => (A && typeof A[k] === 'number') ? A[k] : 0;
          const comAncora = (k, dele) => pos(base(k) + (n(dele) || 0));
          // ---- DERIVA (auditoria) ----
          // Depois que a reconciliacao entrou, "card == analyzer" e' verdade por construcao —
          // olhar so o valor final nao prova nada. O que prova e' QUANTO o carimbo teve que
          // mexer: se a nossa soma ao vivo estivesse errada (preco de potion, foto, bola fora
          // do catalogo), a correcao apareceria aqui todo ciclo. Deriva ~0 = a matematica do
          // card se sustenta sozinha, sem o painel do jogo aberto.
          // No ciclo em que a gente (re)ancora, a deriva e' 0 por construcao — medir ali nao
          // diz nada e ainda contamina o historico com um numero falso de "acerto".
          if (V.anSync && !precisaAncorar) {
            const d = { kills: V.kills - comAncora('kills', m.kills),
              loot: V.lootGold - comAncora('lootGold', m.lootGold),
              supply: V.supplyGold - comAncora('supplyGold', m.supplyGold),
              capturas: V.capturesGold - comAncora('capturesGold', m.capturesGold),
              xp: V.xp - comAncora('xp', m.xpGained),
              seg: Math.round((Date.now() - V.anSync) / 1000), ts: Date.now() };
            d.saldo = d.loot + d.capturas - d.supply;
            V.deriva = d;
            V.derivas = (V.derivas || []).concat([d]).slice(-40);
            // A MEDICAO QUE IMPORTA e' a da janela LONGA: painel fechado por horas, reaberto por
            // 30s. Com o painel aberto o analyzer chega a cada 1-3s, entao 40 amostras somem em
            // 1 minuto e essa medicao seria descartada antes de alguem ler. Aqui ela fica
            // guardada de vez: o ciclo com o maior intervalo desde a ultima reconciliacao.
            if (!V.derivaLonga || d.seg > V.derivaLonga.seg) V.derivaLonga = d;
          }
          if (n(m.kills) != null) V.kills = comAncora('kills', m.kills);
          if (n(m.xpGained) != null) V.xp = comAncora('xp', m.xpGained);
          // loot: guarda a DIFERENCA pro bruto do catalogo, senao o proximo drops() apaga
          if (n(m.lootGold) != null) { V.lootGold = comAncora('lootGold', m.lootGold); V.lootAjuste = V.lootGold - (V.lootBruto || 0); }
          if (n(m.lootItems) != null) { V.lootItems = comAncora('lootItems', m.lootItems); V.itensAjuste = V.lootItems - (V.itensBruto || 0); }
          if (n(m.capturesGold) != null) V.capturesGold = comAncora('capturesGold', m.capturesGold);
          if (n(m.supplyGold) != null) V.supplyGold = comAncora('supplyGold', m.supplyGold);
          if (n(m.captures) != null) V.caught = comAncora('captures', m.captures);
          if (n(m.ballsUsed) != null) V.ballsUsed = comAncora('ballsUsed', m.ballsUsed);
          if (n(m.potionsUsed) != null) V.potionsUsed = comAncora('potionsUsed', m.potionsUsed);
          // COTACAO DA FOTO pelo residuo do Saldo do jogo: ele conta a foto no Saldo mas nao no
          // Loot, entao o que sobra e' o valor dela. So serve pra APRENDER o preco — o nosso
          // fotoGold nao e' mais gravado aqui (ver `fotoValor()`): guardar contador e valor em
          // campos separados deixava os dois dessincronizarem, e o card chegou a exibir
          // "Rare Pokemon Picture x2 -> $0" em 23/07.
          if (n(m.balance) != null && n(m.lootGold) != null && n(m.capturesGold) != null && n(m.supplyGold) != null && V.fotosSess > 0) {
            const paineis = (n(m.lootGold) || 0) + (n(m.capturesGold) || 0) - (n(m.supplyGold) || 0);
            const extra = (n(m.balance) || 0) - paineis;
            if (extra > 0) V.fotoPreco = Math.round(extra / V.fotosSess);
          }
          // COTACAO DIRETA: o `drops` do analyzer ja vem com o gold que o JOGO calculou por
          // item. Quando a foto esta la, da pra ler o preco unitario sem depender do residuo do
          // Saldo nem do nosso contador de fotos da sessao. Fica guardado pra valorizar as
          // proximas fotos com o painel FECHADO — que e' o modo real do produto.
          if (Array.isArray(m.drops)) for (const dr of m.drops) {
            if (dr && dr.qty > 0 && /rare\s*pok.?mon\s*picture/i.test(dr.name || '')) {
              const unit = Math.round(dr.gold / dr.qty);
              if (unit > 0) { V.fotoPreco = unit; V.fotoPrecoTs = Date.now(); }
            }
          }
          // O RELOGIO E' NOSSO. Antes a gente puxava o `seconds` do analyzer achando que era o
          // tempo na hunt — nao e': e' o tempo desde que o PAINEL foi aberto. Copiar aquilo
          // encolhia o nosso cronometro pra "0s" toda vez que o dono abrisse o painel, e
          // estourava o $/h junto. Nosso `since` conta a hunt de verdade, inclusive as horas em
          // que o painel esteve fechado — que e' justamente o que o jogo nao sabe dizer.
          V.fotoGold = fotoValor();   // a cotacao pode ter acabado de ser aprendida acima
          V.anSync = Date.now();
          flush();                // ancoragem importante demais pra esperar o debounce de 1s
          break;
        }
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
          // stats/tipos/xp/power vem no roster (descoberto 23/07) — servem pro card e pro futuro
          // painel "Avaliar IV" do dashboard. HP/level daqui e' so o valor de LOGIN; o ao vivo
          // vem de `field`/`poke-xp` (heroHp/liderLevel), que tem prioridade na hora de exibir.
          if (lead) V.lider = { name: lead.name, speciesId: lead.speciesId, level: lead.level,
            shiny: !!lead.shiny, hp: lead.hp, maxHp: lead.maxHp, quality: lead.quality, ivTotal: lead.ivTotal,
            xp: lead.xp, power: lead.power, type1: lead.type1, type2: lead.type2, stats: lead.stats,
            sellValue: lead.sellValue, id: lead.id };
          // semente do xp/level ao vivo, caso o poke-xp ainda nao tenha chegado
          if (lead && V.liderXp == null) V.liderXp = lead.xp;
          if (lead && V.liderLevel == null) V.liderLevel = lead.level;

          // CAPTURAS — MEDIDO em 22/07/2026: `poke-delta` SUMIU do protocolo (a lista de
          // tipos que chega hoje e field/field-kill/catch-result/poke-xp/pokes/balls/...).
          // Resultado: caught ficava 0 e capturesGold 0 mesmo capturando, e o Profit saia
          // ~18k abaixo do Saldo do jogo. Agora a captura e detectada aqui: `pokes` traz a
          // colecao INTEIRA (id, sellValue, quality, ivTotal, shiny), entao id que nunca vimos
          // = bicho novo. A PRIMEIRA lista (login) so sincroniza os ids, senao a colecao
          // inteira entraria como "capturada agora".
          // SO conta se o jogo avisou uma captura (catch-result success) ha pouco. Sem esse
          // portao, qualquer lista `pokes` de outro contexto — market, depot, breeding —
          // entrava como captura: no teste de 22/07 deu 28 "capturas" e R$1,2 mi de
          // capturesGold com o dono parado no market.
          const primeira = !P.pokesSync;
          for (const p of lista) {
            if (!p || !p.id || P.ids[p.id]) continue;
            P.ids[p.id] = 1;
            if (primeira) continue;
            if (!P.esperandoCaptura) continue;   // id novo sem captura anunciada = nao e' bicho capturado
            P.esperandoCaptura--;
            V.caught++; V.tot.caught++;
            V.capturesGold += (p.sellValue || 0);
            if (p.shiny) { V.shiniesCaught++; V.tot.shiniesCaught++; V.shinies++; V.tot.shinies++; }
            V.lastCatch = { name: p.name, quality: p.quality, ivTotal: p.ivTotal, power: p.power,
              shiny: !!p.shiny, sellValue: p.sellValue, speciesId: p.speciesId, ball: P.lastBall };
            V.catches.push({ name: p.name, quality: p.quality, ivTotal: p.ivTotal,
              shiny: !!p.shiny, speciesId: p.speciesId, ts: Date.now() });
            if (V.catches.length > 200) V.catches.shift();
          }
          P.pokesSync = 1;
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