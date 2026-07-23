// ============================================================
// cdp.js — leitor de valores do jogo via Chrome DevTools Protocol.
// Cada Chrome e lancado com --remote-debugging-port unico; aqui a gente
// conecta e roda um Runtime.evaluate pra puxar o saldo/loot da pagina.
// Usa 'ws' (pure-JS, zero deps nativas) — copiado pra distribuicao.
// ============================================================
let WebSocket = null
try { WebSocket = require('ws') } catch (e) { /* dist sem ws -> readLoot vira no-op */ }

// lista os alvos do Chrome naquela porta e acha a aba (page) do jogo
async function getPageWs (port) {
  const r = await fetch(`http://127.0.0.1:${port}/json`)
  const list = await r.json()
  const page = (list || []).find(t => t.type === 'page' && t.webSocketDebuggerUrl)
  return page ? page.webSocketDebuggerUrl : null
}

// abre o ws, roda UM Runtime.evaluate e devolve o valor (returnByValue)
function evaluate (wsUrl, expression, timeout = 4000) {
  return new Promise((resolve) => {
    if (!WebSocket) return resolve(null)
    let done = false
    let ws
    const finish = (v) => { if (!done) { done = true; try { ws && ws.close() } catch {} resolve(v) } }
    try { ws = new WebSocket(wsUrl) } catch { return resolve(null) }
    const timer = setTimeout(() => finish(null), timeout)
    ws.on('open', () => ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true }
    })))
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.id === 1) {
          clearTimeout(timer)
          finish(msg.result && msg.result.result ? msg.result.result.value : null)
        }
      } catch {}
    })
    ws.on('error', () => { clearTimeout(timer); finish(null) })
  })
}

// Heuristica v1 (tunar ao vivo): mira o valor rotulado "Loot" no painel Hunt
// Analyzer do jogo (ex.: "$327.956 Loot (50.932 itens)"). Se o painel estiver
// fechado, cai no fallback: maior "$N" visivel. Ha varios "$" na tela, entao
// pegar so o maior daria errado -> por isso ancora no rotulo Loot primeiro.
const LOOT_EXPR = "(()=>{try{" +
  "const leaf=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&/^Loot\\b/i.test((e.textContent||'').trim()));" +
  "if(leaf){let p=leaf.parentElement;for(let k=0;k<3&&p;k++){const m=(p.innerText||'').match(/\\$\\s*([\\d.]+)/);if(m)return parseInt(m[1].replace(/\\./g,''),10);p=p.parentElement;}}" +
  "const t=document.body.innerText||'';const all=[...t.matchAll(/\\$\\s*([\\d.]{1,15})/g)].map(x=>parseInt(x[1].replace(/\\./g,''),10)).filter(n=>!isNaN(n));" +
  "return all.length?Math.max(...all):null}catch(e){return null}})()"

// espera a pagina do jogo terminar de carregar (pra revelar sem flash branco)
async function waitReady (port, timeout = 4000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const ws = await getPageWs(port)
      if (ws) {
        const st = await evaluate(ws, 'document.readyState', 1200)
        if (st === 'complete') return true
      }
    } catch {}
    await new Promise(r => setTimeout(r, 180))
  }
  return false
}

async function readLoot (port) {
  try {
    const wsUrl = await getPageWs(port)
    if (!wsUrl) return null
    return await evaluate(wsUrl, LOOT_EXPR)
  } catch { return null }
}

// ------------------------------------------------------------------
// Dashboard: le o HUD do jogo (nome/nivel/zona, HP, mon ativo, status
// da hunt e contadores de bola). Best-effort, ancorado em ROTULOS de
// texto (como o LOOT_EXPR) -> sobrevive a mudanca de classes. Campos
// que nao achar voltam null; a UI degrada com "—". Tuna ao vivo.
// A funcao roda DENTRO da pagina do jogo (so usa document/window).
// ------------------------------------------------------------------
function _stateFn () {
  try {
    // ---- O BRIDGE VEM PRIMEIRO ----
    // leitura ao vivo via localStorage.__vperts (populado pelo content.js).
    // NAO e' interceptacao — so leitura de um valor. Traz kills/xp/catches/shiny/bolas/loot.
    let live = null
    try {
      const raw = localStorage.getItem('__vperts')
      if (raw) {
        const w = JSON.parse(raw)
        live = { kills: w.kills, xp: w.xp, caught: w.caught, brokenBalls: w.brokenBalls, shinies: w.shinies,
          brokenShiny: w.brokenShiny, shiniesCaught: w.shiniesCaught, shinyWild: w.shinyWild, photos: w.photos,
          lastCatch: w.lastCatch, bestCatch: w.bestCatch, catches: w.catches, rareDrops: w.rareDrops,
          potions: w.potions, revives: w.revives, rareItems: w.rareItems, cura: w.cura, usando: w.usando,
          drops: w.drops, lootGold: w.lootGold, lootItems: w.lootItems, capturesGold: w.capturesGold, ballsUsed: w.ballsUsed,
          supplyGold: w.supplyGold, potionsUsed: w.potionsUsed, anTs: w.anTs,
          lider: w.lider,
          ballCounts: w.ballCounts, ballCatalog: w.ballCatalog, msgs: w.msgs, startTs: w.startTs,
          lastMsgTs: w.lastMsgTs, lastKillTs: w.lastKillTs, lastFieldTs: w.lastFieldTs,
          hunt: w.hunt, an: w.an, tot: w.tot, offline: w.offline }
      }
    } catch (e) {}

    // ---- COM O BRIDGE VIVO, NAO SE VARRE O DOM ----
    // O DOM nao tem nada que o WS ja nao entregue melhor, e a varredura custa caro DENTRO do
    // renderer do jogo: root.querySelectorAll('*') em milhares de nos + document.body.innerText
    // (reflow sincrono). Como os 4 overlays, o dashboard e o grid de stats chamam o leitor a
    // cada 2,5-4s e CADA chamada le TODAS as contas, isso dava ~5 varreduras por segundo por
    // conta. Bridge com mensagem nos ultimos 60s = pula a varredura inteira.
    const vivo = !!(live && live.msgs && (Date.now() - (live.lastMsgTs || 0)) < 60000)
    const root = document.querySelector('#game-root') || document.body
    // textContent, NAO innerText: innerText forca um reflow sincrono a cada chamada e essa
    // varredura roda em milhares de folhas — era isso que dava a engasgada periodica no
    // jogo enquanto o dashboard estava aberto. Em folha o texto e o mesmo.
    const leaves = vivo ? [] : [...root.querySelectorAll('*')].filter(e => e.children.length === 0)
    const T = e => ((e.textContent || '').trim())
    const toInt = s => { const m = String(s).match(/([\d][\d.]*)/); return m ? parseInt(m[1].replace(/\./g, ''), 10) : null }
    const body = vivo ? '' : (document.body.innerText || '')

    // nivel + zona: "Nível 203 · Hard Golem"
    let level = null, zone = null, name = null
    const lvl = leaves.find(e => /^N[ií]vel\s+\d+/i.test(T(e)))
    if (lvl) {
      const m = T(lvl).match(/N[ií]vel\s+(\d+)\s*[·|\-–]?\s*(.*)$/i)
      if (m) { level = +m[1]; zone = (m[2] || '').trim() || null }
      for (const a of [lvl.previousElementSibling, lvl.parentElement && lvl.parentElement.previousElementSibling]) {
        if (a) { const t = T(a); if (/^[A-Za-z0-9_]{3,20}$/.test(t)) { name = t; break } }
      }
    }
    if (!name) {
      const nl = leaves.find(e => { const t = T(e); return /^[A-Za-z0-9_]{3,20}$/.test(t) && !/^\d+$/.test(t) && !/^(exp|lv|hp|ball|bola|menu|chat)$/i.test(t) })
      if (nl) name = T(nl)
    }

    // HP: "3752/4620"
    let hp = null, hpMax = null
    const hpEl = leaves.find(e => /^\d{1,6}\s*\/\s*\d{1,6}$/.test(T(e)))
    if (hpEl) { const m = T(hpEl).match(/(\d+)\s*\/\s*(\d+)/); if (m) { hp = +m[1]; hpMax = +m[2] } }

    // mon ativo: "[202] Vileplume" ou "Vileplume (ativo)"
    let active = null
    const monEl = leaves.find(e => /\(ativo\)/i.test(T(e))) || leaves.find(e => /^\[\d+\]\s*\S/.test(T(e)))
    if (monEl) {
      const t = T(monEl); const m = t.match(/^\[\d+\]\s*(.+)$/) || t.match(/^(.+?)\s*\(ativo\)/i)
      if (m) active = (m[1] || '').trim()
    }

    // hunt: "Procurando Pokémon selvagem…", "N selvagem", timer mm:ss
    let searching = false, wild = null, huntSeen = false, timer = null
    if (leaves.find(e => /procurando.*selvage/i.test(T(e)))) { searching = true; huntSeen = true }
    const wEl = leaves.find(e => /^\d+\s+selvage/i.test(T(e)))
    if (wEl) { wild = toInt(T(wEl)); huntSeen = true }
    const tEl = leaves.find(e => /^\d{1,2}:\d{2}$/.test(T(e))); if (tEl) timer = T(tEl)

    // bolas: acha o rotulo e o numero mais proximo (subindo ate 4 pais)
    const ballDefs = [['poke', /pok[eé]\s*ball/i], ['ultra', /ultra\s*ball/i], ['idle', /idle\s*ball/i], ['great', /great\s*ball/i], ['master', /master\s*ball/i]]
    const balls = {}
    const cands = vivo ? [] : [...root.querySelectorAll('[aria-label],[title],button,span,div')]
    for (const [key, re] of ballDefs) {
      const el = cands.find(e => {
        const lab = ((e.getAttribute && (e.getAttribute('aria-label') || e.getAttribute('title'))) || '') + ' ' + (e.children.length < 4 ? T(e) : '')
        return re.test(lab)
      })
      if (!el) continue
      let p = el, n = null
      for (let k = 0; k < 4 && p; k++) { const m = (p.innerText || '').match(/(\d[\d.]{0,7})/); if (m) { n = parseInt(m[1].replace(/\./g, ''), 10); break } p = p.parentElement }
      if (n != null) balls[key] = n
    }

    // best-effort (so quando o painel Inventario/Captura esta aberto)
    const grab = re => { const m = body.match(re); return m ? parseInt(m[1].replace(/\./g, ''), 10) : null }
    const potions = grab(/(\d[\d.]*)\s*(?:po[çc][õo]es|potions?)/i) || grab(/potions?\s*[:\-]?\s*(\d[\d.]*)/i)
    const revives = grab(/(\d[\d.]*)\s*(?:revives?|reviver)/i) || grab(/revives?\s*[:\-]?\s*(\d[\d.]*)/i)

    // Hunt Analyzer (painel aberto): o numero vem ANTES do rotulo (ancora no rotulo, sobe ate 3 pais)
    const numFrom = (t, money) => { const m = String(t).match(money ? /(-?)\s*\$\s*([\d.]+)/ : /([\d.]+)/); if (!m) return null; const n = parseInt((money ? m[2] : m[1]).replace(/\./g, ''), 10); return (money && m[1] === '-') ? -n : n }
    const byLabel = (re, money) => { const el = leaves.find(e => re.test(T(e))); if (!el) return null; let p = el.parentElement; for (let k = 0; k < 3 && p; k++) { const n = numFrom(p.innerText || '', money); if (n != null) return n; p = p.parentElement } return null }
    let cashH = null; const chm = body.match(/\$\s*([\d.]+)\s*\/\s*h/i); if (chm) cashH = parseInt(chm[1].replace(/\./g, ''), 10)
    const an = { loot: byLabel(/^Loot\b/i, true), kills: byLabel(/^Derrotados\b/i), caught: byLabel(/^Capturados\b/i), saldo: byLabel(/^Saldo\b/i, true), cashH }
    const hasAn = an.loot != null || an.kills != null || an.caught != null

    // dinheiro/gold (pro income/h por DELTA, sem precisar do Hunt Analyzer):
    // maior "$N" visivel. Com o painel fechado = saldo do jogador; com ele
    // aberto = total de loot da sessao — os dois crescem, entao o delta vira loot/h.
    let money = null
    const monies = (body.match(/\$\s*[\d.]+/g) || []).map(s => parseInt(s.replace(/[^\d]/g, ''), 10)).filter(n => !isNaN(n))
    if (monies.length) money = Math.max.apply(null, monies)

    const shinies = live && live.shinies != null ? live.shinies : null
    const brokenShiny = live && live.brokenShiny != null ? live.brokenShiny : null

    // Bolas: o WS manda `counts` (id -> qtd) E o `catalog` com nome/icone de cada id.
    // Antes um mapa de ids CHUTADO no codigo decidia o que era cada bola — bola nova ou
    // id diferente sumia do painel calada. Agora o nome e o icone vem do proprio jogo.
    let finalBalls = balls, ballList = null
    if (live && live.ballCounts) {
      const cat = {}
      ;(live.ballCatalog || []).forEach(b => { if (b && b.id != null) cat[String(b.id)] = b })
      const DIA = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g')
      const slug = s => String(s || '').normalize('NFD').replace(DIA, '')
        .toLowerCase().replace(/ball/g, '').replace(/[^a-z0-9]/g, '') || null
      const wb = {}; ballList = []
      for (const id in live.ballCounts) {
        const qty = live.ballCounts[id]; if (qty == null) continue
        const c = cat[id]
        const key = (c && slug(c.name)) || ('id' + id)
        wb[key] = qty
        const nome = (c && c.name) || ('Bola ' + id)
        ballList.push({ id, key, name: nome, qty, icon: (c && c.iconUrl) || null, idle: key === 'idle' || /idle/i.test(nome) })
      }
      // por QUANTIDADE (maior primeiro): a UI mostra so a maior + a idle, e o icone do
      // card passa a ser o da bola que a conta realmente esta usando
      if (ballList.length) { finalBalls = wb; ballList.sort((a, b) => (b.qty || 0) - (a.qty || 0)) }
    }
    const ballsTotal = Object.values(finalBalls).reduce((a, b) => a + (b || 0), 0)

    // O painel NAO depende mais do Hunt Analyzer do jogo. O `analyzer` do WS so chega
    // enquanto AQUELE painel esta aberto — usar ele como fonte deixava Loot/Supply/Saldo/$h
    // congelados num snapshot velho (e zerados enquanto ninguem abrisse o painel no jogo).
    // Agora a fonte e' o que o bridge soma ao vivo (field-kill + poke-delta + catch-result +
    // inventory) valorizado pelo npcPrice do catalogo. O analyzer fica so pra conferencia,
    // carimbado com a idade em segundos.
    let anF = hasAn ? an : null
    if (live && live.an) {
      const a = live.an
      anF = { loot: a.lootGold, kills: a.kills, caught: a.captures, saldo: a.balance,
        cashH: a.goldPerHour, xpH: a.xpPerHour, killsH: a.killsPerHour, shinyCaptures: a.shinyCaptures,
        seconds: a.seconds, lootItems: a.lootItems, capturesGold: a.capturesGold,
        supplyGold: a.supplyGold, ballsUsed: a.ballsUsed, potionsUsed: a.potionsUsed,
        drops: a.drops || [], fonte: 'ws', ts: live.anTs || null,
        idade: live.anTs ? Math.round((Date.now() - live.anTs) / 1000) : null }
    }
    // tempo na hunt: conta desde o field-init (sinal do WS, sempre vivo). O `seconds` do
    // analyzer so entra se o field-init ainda nao tiver passado por aqui.
    let huntSec = null
    if (live && live.hunt && live.hunt.since) huntSec = Math.round((Date.now() - live.hunt.since) / 1000)
    else if (live && live.an && live.an.seconds != null) huntSec = live.an.seconds
    const horas = huntSec ? huntSec / 3600 : 0
    // menos de ~15s de hunt nao da taxa confiavel (dividir por quase zero estoura o /h)
    const porH = (v) => (horas > 0.004 && v != null) ? Math.round(v / horas) : null

    // Bloco financeiro no formato do Hunt Analyzer do jogo (Loot + Capturas - Supply),
    // 100% com dado vivo. `aprox` segue marcando que o preco e' o de NPC do catalogo — o
    // painel do jogo pode estar com "preco de Mercado" ligado, entao nao bate no centavo.
    let fin = null
    if (live && live.lootGold != null) {
      const loot = live.lootGold, cap = live.capturesGold || 0, sup = live.supplyGold || 0
      const saldo = loot + cap - sup
      fin = { loot, lootItens: live.lootItems, capturas: cap, supply: sup, saldo,
        cashH: porH(saldo), bolas: live.ballsUsed, potions: live.potionsUsed,
        aprox: true, fonte: 'vivo',
        // gastou bola e o Supply nao saiu do zero = o id da bola nao esta no catalogo de
        // itens (ou veio sem npcPrice). Melhor avisar do que mostrar saldo inflado calado.
        supplyParcial: sup === 0 && (live.ballsUsed || 0) > 0 }
    } else if (hasAn) {                       // sem bridge: ultimo recurso, o DOM do painel
      fin = { loot: an.loot, saldo: an.saldo, cashH: an.cashH, aprox: false, fonte: 'dom' }
    }
    // taxas da sessao calculadas do dado vivo — nada de xpPerHour/killsPerHour do analyzer
    const taxa = live ? { xpH: porH(live.xp), killsH: porH(live.kills), cashH: fin ? fin.cashH : null } : null
    // drops da sessao: os do bridge (npcPrice, sempre frescos). O analyzer so entra pra dar
    // o valor de MERCADO quando o snapshot dele for recente (<150s).
    let dropsF = live ? live.drops : null
    const anFresco = !!(live && live.anTs && (Date.now() - live.anTs) < 150000)
    if (anFresco && Array.isArray(live.an.drops) && live.an.drops.length) {
      const ico = {}; (live.drops || []).forEach(d => { if (d.icon) ico[d.name] = d.icon })
      dropsF = live.an.drops.map(d => ({ name: d.name, qty: d.qty, gold: d.gold, icon: ico[d.name] || null }))
        .sort((x, y) => (y.gold || 0) - (x.gold || 0)).slice(0, 14)
    }
    // NA HUNT? Só vale sinal de campo do WS. O texto da tela ("Procurando…") continuava
    // aparecendo depois de sair, e "matou algo faz pouco" segurava o verde por minutos —
    // os dois davam HUNT com a conta parada no mercado. Agora: mob no campo ou kill nos
    // ultimos 60s (a ~500 kills/h, e' um kill a cada ~7s; 60s parado ja e' fora).
    let huntF = { seen: huntSeen, searching, wild, timer }
    if (live && (live.lastFieldTs || live.lastKillTs || live.hunt)) {
      const ult = Math.max(live.lastFieldTs || 0, live.lastKillTs || 0)
      huntF = { seen: !live.offline && !!ult && (Date.now() - ult) < 60000,
        searching, wild, timer, desde: ult, slug: live.hunt && live.hunt.slug, fonte: 'ws' }
    }
    // potions/revives: ESTOQUE do inventario (WS + catalogo de itens). O numero do DOM vinha
    // do "Supply (... N potions)" do Hunt Analyzer, que e o CONSUMO da sessao — so serve de
    // ultimo recurso, e agora vai rotulado como usado.
    const potionsF = (live && live.potions != null) ? live.potions : null
    const revivesF = (live && live.revives != null) ? live.revives : null
    // gasto de cura da sessao: o delta do inventario (vivo). DOM/analyzer so sem bridge.
    const potionsUsed = (live && live.potionsUsed != null) ? live.potionsUsed
      : (live && live.an && live.an.potionsUsed != null) ? live.an.potionsUsed : potions
    // sem varredura do DOM a "zona" viria vazia e o subtitulo dos cards sumia — o slug da
    // hunt do WS diz a mesma coisa (e mais confiavel que o texto da tela)
    if (!zone && live && live.hunt && live.hunt.slug) zone = live.hunt.slug
    return { ok: true, ts: Date.now(), name, level, zone, active, hp, hpMax, hunt: huntF, vivo,
      balls: finalBalls, ballList, ballsTotal, potions: potionsF, revives: revivesF, potionsUsed,
      cura: live ? live.cura : null, usando: live ? live.usando : null,
      rareItems: live ? live.rareItems : null, money, shinies, brokenShiny,
      fin, huntSec, taxa, drops: dropsF,
      // time da conta pelo WS: nome/nivel/HP do lider vem certo (o DOM so via o canvas)
      lider: live ? live.lider : null,
      photos: live ? live.photos : null, live, an: anF }
  } catch (e) { return { ok: false, err: String((e && e.message) || e) } }
}
const STATE_EXPR = '(' + _stateFn.toString() + ')()'

async function readState (port) {
  try {
    const wsUrl = await getPageWs(port)
    if (!wsUrl) return null
    return await evaluate(wsUrl, STATE_EXPR)
  } catch { return null }
}

module.exports = { readLoot, readState, waitReady, evaluate, getPageWs, LOOT_EXPR, STATE_EXPR, available: () => !!WebSocket }
