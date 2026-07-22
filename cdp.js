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
    const root = document.querySelector('#game-root') || document.body
    const leaves = [...root.querySelectorAll('*')].filter(e => e.children.length === 0)
    const T = e => ((e.innerText || e.textContent || '').trim())
    const toInt = s => { const m = String(s).match(/([\d][\d.]*)/); return m ? parseInt(m[1].replace(/\./g, ''), 10) : null }
    const body = (document.body.innerText || '')

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
    const cands = [...root.querySelectorAll('[aria-label],[title],button,span,div')]
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

    // leitura ao vivo via localStorage.__vperts (populado por userscript/Gabriel).
    // NAO e interceptacao — so leitura de um valor. Traz kills/xp/catches/shiny/ball-quebrada.
    let live = null
    try { const raw = localStorage.getItem('__vperts'); if (raw) { const w = JSON.parse(raw); live = { kills: w.kills, xp: w.xp, caught: w.caught, brokenBalls: w.brokenBalls, shinies: w.shinies, brokenShiny: w.brokenShiny, shiniesCaught: w.shiniesCaught, lastCatch: w.lastCatch, bestCatch: w.bestCatch, rareDrops: w.rareDrops, ballCounts: w.ballCounts, msgs: w.msgs, startTs: w.startTs } } } catch (e) {}
    const shinies = live && live.shinies != null ? live.shinies : null
    const brokenShiny = live && live.brokenShiny != null ? live.brokenShiny : null

    // contagem de bolas do WS (balls.counts, estavel) sobrepoe a leitura do DOM
    let finalBalls = balls
    if (live && live.ballCounts) {
      const BID = { '1': 'poke', '2': 'great', '3': 'super', '4': 'ultra', '5': 'master', '6': 'idle' }
      const wb = {}
      for (const id in live.ballCounts) { const k = BID[id]; if (k && live.ballCounts[id] != null) wb[k] = live.ballCounts[id] }
      if (Object.keys(wb).length) finalBalls = wb
    }
    const ballsTotal = Object.values(finalBalls).reduce((a, b) => a + (b || 0), 0)
    return { ok: true, ts: Date.now(), name, level, zone, active, hp, hpMax, hunt: { seen: huntSeen, searching, wild, timer }, balls: finalBalls, ballsTotal, potions, revives, money, shinies, brokenShiny, live, an: hasAn ? an : null }
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
