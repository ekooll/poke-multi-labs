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

module.exports = { readLoot, waitReady, evaluate, getPageWs, LOOT_EXPR, available: () => !!WebSocket }
