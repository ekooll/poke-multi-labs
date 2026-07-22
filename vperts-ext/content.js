// ---- cap de fps DINAMICO — instalado ANTES dos scripts do jogo (pega refs capturadas) ----
// main-lite ajusta window.__vpFpsCap por tela: 0 = full · 15 = eco · 3 = fora de foco
(function () {
  if (!window.__vpRAF0) { window.__vpRAF0 = window.requestAnimationFrame.bind(window); window.__vpCAF0 = window.cancelAnimationFrame.bind(window); }
  if (window.__vpFpsCap == null) window.__vpFpsCap = 0;
  window.requestAnimationFrame = function (cb) {
    var cap = window.__vpFpsCap;
    if (!cap) return window.__vpRAF0(cb);
    return setTimeout(function () { cb(performance.now()); }, 1000 / cap);
  };
  window.cancelAnimationFrame = function (id) { if (window.__vpFpsCap) clearTimeout(id); else window.__vpCAF0(id); };
})();

(function () {
  console.log('%c[Vperts] bridge (extensao) rodando', 'color:#e5b34f;font-weight:bold');
  const Orig = window.WebSocket;
  const V = { msgs:0, kills:0, xp:0, attempts:0, caught:0, brokenBalls:0, shinies:0, brokenShiny:0,
    shiniesCaught:0, lastCatch:null, bestCatch:null, catches:[], rareDrops:[], loot:{}, ballCounts:null, examples:{}, _expect:null, byType:{}, startTs:Date.now() };
  const RARE = /ferom|pheromone|strange|foto|photo|picture/i;
  const addRare = (tag) => { if (V.rareDrops.indexOf(tag) === -1) { V.rareDrops.push(tag); if (V.rareDrops.length > 12) V.rareDrops.shift(); } };
  const save = () => { try { localStorage.setItem('__vperts', JSON.stringify(V)); } catch(e){} };
  window.WebSocket = function (url, protos) {
    const ws = protos !== undefined ? new Orig(url, protos) : new Orig(url);
    ws.addEventListener('message', (ev) => {
      const d = ev.data; if (typeof d !== 'string') return; V.msgs++;
      let m; try { m = JSON.parse(d); } catch(e){ return; } const t = m && m.type; if (!t) return;
      V.byType[t] = (V.byType[t]||0)+1;
      if (t === 'balls' && m.counts) V.ballCounts = m.counts;
      else if (t === 'field-kill') {
        V.kills++; if (typeof m.xpGained === 'number') V.xp += m.xpGained;
        if (Array.isArray(m.loot)) m.loot.forEach(it => { const nm = it && it.name; if (!nm) return; V.loot[nm] = (V.loot[nm]||0)+(it.qty||0); if (RARE.test(nm)) addRare(nm + (it.qty > 1 ? ' ×' + it.qty : '')); });
      }
      else if (t === 'catch-result') {
        V.attempts++; const shiny = m.shiny === true;
        if (m.success === true) { V.caught++; if (shiny) V.shinies++; V._expect = { shiny }; }
        else { V.brokenBalls++; if (shiny) { V.shinies++; V.brokenShiny++; } }
      }
      else if (t === 'poke-delta' && m.poke && V._expect) {
        const p = m.poke;
        V.lastCatch = { name:p.name, quality:p.quality, ivTotal:p.ivTotal, power:p.power, shiny:!!p.shiny, sellValue:p.sellValue };
        if (p.shiny) V.shiniesCaught++;
        V.catches.push({ name:p.name, quality:p.quality, ivTotal:p.ivTotal, shiny:!!p.shiny });
        if (V.catches.length > 200) V.catches.shift();
        if (!V.bestCatch || (p.quality||0) > (V.bestCatch.quality||0)) V.bestCatch = { name:p.name, quality:p.quality, ivTotal:p.ivTotal };
        V._expect = null;
      }
      else if (t === 'profession-photo') { addRare('📸 Foto'); }
      if (V.msgs % 5 === 0) save();
    });
    return ws;
  };
  window.WebSocket.prototype = Orig.prototype;
  ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(k => window.WebSocket[k] = Orig[k]);
  save();
})();