/**
 * report.js — self-contained dark HTML report (sliders, audio players, analysis)
 * for one sweep run.
 *
 *   node src/report.js [runDir]     default: runs/<runName from sweep.config.json>
 *
 * Reads <runDir>/run.json + results.jsonl, writes <runDir>/report.html.
 * Audio is referenced relatively (audio/<id>.mp3) or by absolute URL (baseline).
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function resolveRunDir() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, "sweep.config.json"), "utf8"));
  return path.join(ROOT, "runs", conf.runName);
}

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── Load + dedupe data ──────────────────────────────────────────────────────
function loadData(runDir) {
  const file = path.join(runDir, "results.jsonl");
  if (!fs.existsSync(file)) { console.error(`No results at ${file}`); process.exit(1); }
  const raw = fs.readFileSync(file, "utf8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
  console.log(`Loaded ${raw.length} records from ${path.relative(ROOT, file)}`);

  const seen = {};
  for (const r of raw) {
    if (r.error) continue;
    const key = `${r.model}|${r.stability}|${r.similarity}|${r.speed}`;
    if (!seen[key] || r.timestamp > seen[key].timestamp) seen[key] = r;
  }

  const fields = ["id","model","stability","similarity","speed","genTimeMs","fileSizeBytes",
    "durationSec","speechDurSec","segVols","volSpreadDb","volMeanDb",
    "pauseCount","pauseTotalSec","pauseMaxSec","pauseAvgSec","charsPerSec","wordsPerSec"];
  const clean = Object.values(seen).map(r => {
    const o = {};
    for (const k of fields) if (r[k] !== undefined) o[k] = r[k];
    o.audio = r.audioFile || r.blobUrl;
    return o;
  });
  clean.sort((a, b) => a.model.localeCompare(b.model) || a.stability - b.stability
    || a.similarity - b.similarity || (a.speed || 999) - (b.speed || 999));
  console.log(`Deduped to ${clean.length} records`);
  return clean;
}

// ── HTML generation ─────────────────────────────────────────────────────────
function generateHTML(data, meta) {
  const dataJSON = JSON.stringify(data).replace(/</g, "\\u003c");
  const n = k => new Set(data.map(d => d[k])).size;
  const sub = `${esc(meta.voice?.name)} · ${data.length} configurations · ${n("model")} models × `
    + `${n("stability")} stabilities × ${n("similarity")} similarities × ${n("speed")} speeds`;
  return buildPage(dataJSON, meta, sub, data.length);
}

function buildPage(dataJSON, meta, sub, total) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ElevenLabs Arabic TTS Sweep — ${esc(meta.runName)}</title>
<style>${getCSS()}</style>
</head>
<body>
<div id="app">
  <header>
    <h1>🎙️ ElevenLabs Arabic TTS Parameter Sweep</h1>
    <p class="sub">${sub}</p>
    <p class="sub">Run <code>${esc(meta.runName)}</code>${meta.startedAt ? " · " + esc(meta.startedAt.slice(0, 10)) : ""}</p>
    ${meta.text ? `<p class="script" dir="rtl" lang="ar">${esc(meta.text)}</p>` : ""}
  </header>

  <section id="summary" class="card">
    <h2>📊 Model Summary</h2>
    <div id="modelSummary"></div>
  </section>

  <section id="controls" class="card">
    <h2>🎛️ Parameter Controls</h2>
    <div class="slider-grid">
      <div class="slider-group">
        <label>Model</label>
        <div class="btn-group" id="modelBtns"></div>
      </div>
      <div class="slider-group">
        <label>Stability: <span id="stabVal">ALL</span></label>
        <input type="range" id="stabSlider" min="-1" max="4" step="1" value="-1">
        <div class="tick-labels" id="stabTicks"></div>
      </div>
      <div class="slider-group">
        <label>Similarity: <span id="simVal">ALL</span></label>
        <input type="range" id="simSlider" min="-1" max="3" step="1" value="-1">
        <div class="tick-labels" id="simTicks"></div>
      </div>
      <div class="slider-group">
        <label>Speed: <span id="spdVal">ALL</span></label>
        <input type="range" id="spdSlider" min="-1" max="3" step="1" value="-1">
        <div class="tick-labels" id="spdTicks"></div>
      </div>
    </div>
    <div class="filter-info">
      <span id="matchCount">${total}</span> configurations match · 
      Sort by: <select id="sortBy">
        <option value="charsPerSec">Speaking Rate (c/s)</option>
        <option value="volSpreadDb">Volume Consistency (dB)</option>
        <option value="balanced">Balanced Score</option>
        <option value="durationSec">Duration</option>
        <option value="genTimeMs">Generation Time</option>
        <option value="pauseCount">Pause Count</option>
      </select>
      <label><input type="checkbox" id="sortAsc" checked> Ascending</label>
    </div>
  </section>

  <section id="search-section" class="card">
    <h2>🔍 Search</h2>
    <input type="text" id="searchBox" placeholder="Search by config ID, model, or any value...">
  </section>

  <section id="best" class="card">
    <h2>🏆 Top Picks</h2>
    <div class="top-grid">
      <div class="top-card" id="topSlowest"></div>
      <div class="top-card" id="topConsistent"></div>
      <div class="top-card" id="topBalanced"></div>
      <div class="top-card" id="topFastest"></div>
    </div>
  </section>

  <section id="results" class="card">
    <h2>📋 Results <span id="resultCount"></span></h2>
    <div id="resultGrid"></div>
  </section>

  <section id="detail-modal" class="modal hidden">
    <div class="modal-content">
      <button class="close-btn" onclick="closeModal()">✕</button>
      <div id="modalBody"></div>
    </div>
  </section>
</div>

<script>
const DATA = ${dataJSON};
${getJS()}
</script>
</body>
</html>`;
}

function getCSS() {
  return `
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0d1117;--card:#161b22;--border:#30363d;--text:#e6edf3;--dim:#8b949e;
--accent:#58a6ff;--green:#3fb950;--red:#f85149;--orange:#d29922;--purple:#bc8cff}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.5;padding:16px;max-width:1400px;margin:0 auto}
header{text-align:center;padding:24px 0;border-bottom:1px solid var(--border);margin-bottom:20px}
h1{font-size:1.8em;margin-bottom:4px}
.sub{color:var(--dim);font-size:0.95em}
h2{font-size:1.2em;margin-bottom:12px;color:var(--accent)}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}
.slider-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:768px){.slider-grid{grid-template-columns:1fr}}
.slider-group{padding:12px;background:var(--bg);border-radius:8px}
.slider-group label{display:block;margin-bottom:6px;font-weight:600;font-size:0.9em}
.slider-group input[type=range]{width:100%;accent-color:var(--accent);cursor:pointer}
.tick-labels{display:flex;justify-content:space-between;font-size:0.75em;color:var(--dim);margin-top:2px;padding:0 2px}
.btn-group{display:flex;gap:6px;flex-wrap:wrap}
.btn-group button{padding:6px 14px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);cursor:pointer;font-size:0.85em;transition:all .15s}
.btn-group button:hover{border-color:var(--accent)}
.btn-group button.active{background:var(--accent);color:#000;border-color:var(--accent);font-weight:600}
.filter-info{margin-top:14px;color:var(--dim);font-size:0.9em;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.filter-info select{background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:4px 8px}
#searchBox{width:100%;padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:0.95em}
#searchBox:focus{outline:none;border-color:var(--accent)}
.top-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
@media(max-width:900px){.top-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:500px){.top-grid{grid-template-columns:1fr}}
.top-card{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;cursor:pointer;transition:border-color .15s}
.top-card:hover{border-color:var(--accent)}
.top-card h3{font-size:0.85em;margin-bottom:6px}
.top-card .val{font-size:1.6em;font-weight:700}
.top-card .detail{font-size:0.78em;color:var(--dim);margin-top:4px}
.top-card audio{width:100%;height:32px;margin-top:8px}
.script{margin:14px auto 0;max-width:900px;padding:12px 16px;background:var(--card);border:1px solid var(--border);border-radius:8px;font-size:1.05em;line-height:1.9}
#modelSummary{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
@media(max-width:700px){#modelSummary{grid-template-columns:1fr}}
.ms-card{background:var(--bg);border-radius:8px;padding:14px;border-left:3px solid var(--accent)}
.ms-card h3{font-size:0.9em;margin-bottom:8px}
.ms-card .stat{display:flex;justify-content:space-between;font-size:0.85em;padding:2px 0}
.ms-card .stat .k{color:var(--dim)}
.ms-card .stat .v{font-weight:600}
#resultGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:10px;max-height:800px;overflow-y:auto;padding-right:4px}
#resultGrid::-webkit-scrollbar{width:6px}
#resultGrid::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.r-card{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;cursor:pointer;transition:all .15s}
.r-card:hover{border-color:var(--accent);transform:translateY(-1px)}
.r-card .r-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.r-card .r-model{font-size:0.8em;padding:2px 8px;border-radius:4px;font-weight:600}
.r-card .r-model.m-v2{background:#1a3a2a;color:var(--green)}
.r-card .r-model.m-v3{background:#1a2a3a;color:var(--accent)}
.r-card .r-model.m-flash{background:#2a2a1a;color:var(--orange)}
.r-card .r-params{font-size:0.78em;color:var(--dim)}
.r-card .r-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin:8px 0}
.r-card .r-stat{text-align:center}
.r-card .r-stat .sv{font-size:1.1em;font-weight:700}
.r-card .r-stat .sl{font-size:0.7em;color:var(--dim)}
.r-card audio{width:100%;height:28px;margin-top:4px}
.bar{height:4px;border-radius:2px;background:var(--border);margin-top:3px;overflow:hidden}
.bar .fill{height:100%;border-radius:2px;transition:width .3s}
.vol-chart{display:flex;gap:2px;align-items:flex-end;height:40px;margin:8px 0}
.vol-bar{flex:1;background:var(--accent);border-radius:2px 2px 0 0;min-width:8px;transition:height .3s}
.modal{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:100}
.modal.hidden{display:none}
.modal-content{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px;max-width:700px;width:95%;max-height:90vh;overflow-y:auto;position:relative}
.close-btn{position:absolute;top:12px;right:12px;background:none;border:none;color:var(--dim);font-size:1.4em;cursor:pointer}
.close-btn:hover{color:var(--text)}
.d-section{margin-top:16px;padding-top:16px;border-top:1px solid var(--border)}
.d-section h3{font-size:0.95em;margin-bottom:8px}
.d-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.d-item{display:flex;justify-content:space-between;font-size:0.88em;padding:4px 0}
.d-item .dk{color:var(--dim)}
.d-item .dv{font-weight:600}
.d-audio{margin:16px 0}
.d-audio audio{width:100%;height:40px}
.compare-link{display:inline-block;margin-top:8px;color:var(--accent);text-decoration:none;font-size:0.85em}
.compare-link:hover{text-decoration:underline}
.badge{display:inline-block;font-size:0.7em;padding:1px 6px;border-radius:3px;margin-left:6px;font-weight:400}
.badge.good{background:#1a3a2a;color:var(--green)}
.badge.mid{background:#2a2a1a;color:var(--orange)}
.badge.bad{background:#3a1a1a;color:var(--red)}
`;
}

function getJS() {
  return `
const MODELS = [...new Set(DATA.map(d => d.model))].sort();
const STABS = [...new Set(DATA.map(d => d.stability))].sort((a,b) => a-b);
const SIMS = [...new Set(DATA.map(d => d.similarity))].sort((a,b) => a-b);
const SPDS_RAW = [...new Set(DATA.map(d => d.speed))];
const SPDS = SPDS_RAW.sort((a,b) => (a||0)-(b||0));
const SPD_LABELS = SPDS.map(s => s === null ? 'default' : String(s));

let selModel = null;
let selStab = -1, selSim = -1, selSpd = -1;
let searchTerm = '';

// ── Init ──
function init() {
  document.getElementById('stabSlider').max = STABS.length - 1;
  document.getElementById('simSlider').max = SIMS.length - 1;
  document.getElementById('spdSlider').max = SPDS.length - 1;
  renderModelBtns();
  renderSliderTicks();
  renderModelSummary();
  renderTopPicks();
  bindEvents();
  applyFilters();
}

function renderModelBtns() {
  const c = document.getElementById('modelBtns');
  const allBtn = el('button', 'ALL');
  allBtn.className = 'active';
  allBtn.onclick = () => { selModel = null; updateModelBtns(); applyFilters(); };
  c.appendChild(allBtn);
  for (const m of MODELS) {
    const b = el('button', shortModel(m));
    b.onclick = () => { selModel = m; updateModelBtns(); applyFilters(); };
    c.appendChild(b);
  }
}

function updateModelBtns() {
  const btns = document.querySelectorAll('#modelBtns button');
  btns.forEach((b, i) => {
    if (i === 0) b.className = selModel === null ? 'active' : '';
    else b.className = b.textContent === shortModel(selModel) ? 'active' : '';
  });
}

function renderSliderTicks() {
  setTicks('stabTicks', ['ALL', ...STABS.map(String)]);
  setTicks('simTicks', ['ALL', ...SIMS.map(String)]);
  setTicks('spdTicks', ['ALL', ...SPD_LABELS]);
}

function setTicks(id, labels) {
  const c = document.getElementById(id);
  c.innerHTML = labels.map(l => '<span>'+l+'</span>').join('');
}

function bindEvents() {
  document.getElementById('stabSlider').oninput = e => {
    selStab = +e.target.value;
    document.getElementById('stabVal').textContent = selStab < 0 ? 'ALL' : STABS[selStab];
    applyFilters();
  };
  document.getElementById('simSlider').oninput = e => {
    selSim = +e.target.value;
    document.getElementById('simVal').textContent = selSim < 0 ? 'ALL' : SIMS[selSim];
    applyFilters();
  };
  document.getElementById('spdSlider').oninput = e => {
    selSpd = +e.target.value;
    document.getElementById('spdVal').textContent = selSpd < 0 ? 'ALL' : SPD_LABELS[selSpd];
    applyFilters();
  };
  document.getElementById('sortBy').onchange = () => applyFilters();
  document.getElementById('sortAsc').onchange = () => applyFilters();
  document.getElementById('searchBox').oninput = e => {
    searchTerm = e.target.value.toLowerCase();
    applyFilters();
  };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
}

function applyFilters() {
  let filtered = DATA.filter(d => {
    if (selModel && d.model !== selModel) return false;
    if (selStab >= 0 && d.stability !== STABS[selStab]) return false;
    if (selSim >= 0 && d.similarity !== SIMS[selSim]) return false;
    if (selSpd >= 0 && d.speed !== SPDS[selSpd]) return false;
    if (searchTerm) {
      const s = JSON.stringify(d).toLowerCase();
      if (!s.includes(searchTerm)) return false;
    }
    return true;
  });

  const sortKey = document.getElementById('sortBy').value;
  const asc = document.getElementById('sortAsc').checked;
  if (sortKey === 'balanced') {
    filtered.sort((a,b) => score(a) - score(b));
  } else {
    filtered.sort((a,b) => (a[sortKey]||0) - (b[sortKey]||0));
  }
  if (!asc) filtered.reverse();

  document.getElementById('matchCount').textContent = filtered.length;
  document.getElementById('resultCount').textContent = '(' + filtered.length + ')';
  renderResults(filtered);
}

function score(r) { return r.charsPerSec + r.volSpreadDb * 5; }

function renderResults(items) {
  const g = document.getElementById('resultGrid');
  g.innerHTML = '';
  for (const r of items) g.appendChild(makeCard(r));
}

function makeCard(r) {
  const d = document.createElement('div');
  d.className = 'r-card';
  d.onclick = () => showDetail(r);
  const mc = modelClass(r.model);
  const cpsBar = pctInRange(r.charsPerSec, 8, 16);
  const volBar = 100 - pctInRange(r.volSpreadDb, 0, 3);
  const spd = r.speed === null ? 'def' : r.speed;
  d.innerHTML = \`
    <div class="r-head">
      <span class="r-model \${mc}">\${shortModel(r.model)}</span>
      <span class="r-params">st=\${r.stability} · sm=\${r.similarity} · sp=\${spd}</span>
    </div>
    <div class="r-stats">
      <div class="r-stat"><div class="sv">\${r.charsPerSec}</div><div class="sl">chars/s</div>
        <div class="bar"><div class="fill" style="width:\${cpsBar}%;background:\${cpsBar<33?'var(--green)':cpsBar<66?'var(--orange)':'var(--red)'}"></div></div></div>
      <div class="r-stat"><div class="sv">\${r.volSpreadDb}<small>dB</small></div><div class="sl">vol spread</div>
        <div class="bar"><div class="fill" style="width:\${volBar}%;background:\${volBar>66?'var(--green)':volBar>33?'var(--orange)':'var(--red)'}"></div></div></div>
      <div class="r-stat"><div class="sv">\${r.durationSec}<small>s</small></div><div class="sl">duration</div></div>
    </div>
    <audio controls preload="none" src="\${r.audio}"></audio>
  \`;
  return d;
}

function showDetail(r) {
  const m = document.getElementById('detail-modal');
  const b = document.getElementById('modalBody');
  const spd = r.speed === null ? 'default' : r.speed;
  const sc = score(r).toFixed(1);
  const volBars = (r.segVols||[]).map((v,i) => {
    const h = Math.max(5, Math.min(100, ((v + 40) / 30) * 100));
    return '<div class="vol-bar" style="height:'+h+'%" title="Seg '+(i+1)+': '+v+' dB"></div>';
  }).join('');

  b.innerHTML = \`
    <h2>\${shortModel(r.model)} <span class="r-model \${modelClass(r.model)}" style="font-size:0.6em;vertical-align:middle">\${r.model}</span></h2>
    <p style="color:var(--dim);margin-top:4px">Configuration: stability=\${r.stability} · similarity=\${r.similarity} · speed=\${spd}</p>

    <div class="d-audio">
      <audio controls style="width:100%;height:48px" src="\${r.audio}"></audio>
      <a href="\${r.audio}" target="_blank" class="compare-link">⬇ Download MP3</a>
    </div>

    <div class="d-section">
      <h3>📏 Timing</h3>
      <div class="d-grid">
        <div class="d-item"><span class="dk">Total Duration</span><span class="dv">\${r.durationSec}s</span></div>
        <div class="d-item"><span class="dk">Speech Duration</span><span class="dv">\${r.speechDurSec}s</span></div>
        <div class="d-item"><span class="dk">Chars/sec</span><span class="dv">\${r.charsPerSec} \${badge(r.charsPerSec, 10, 13, true)}</span></div>
        <div class="d-item"><span class="dk">Words/sec</span><span class="dv">\${r.wordsPerSec}</span></div>
        <div class="d-item"><span class="dk">Generation Time</span><span class="dv">\${r.genTimeMs}ms</span></div>
        <div class="d-item"><span class="dk">File Size</span><span class="dv">\${(r.fileSizeBytes/1024).toFixed(0)} KB</span></div>
      </div>
    </div>

    <div class="d-section">
      <h3>🔊 Volume Analysis</h3>
      <div class="d-grid">
        <div class="d-item"><span class="dk">Volume Spread</span><span class="dv">\${r.volSpreadDb} dB \${badge(r.volSpreadDb, 1, 2, true)}</span></div>
        <div class="d-item"><span class="dk">Mean Volume</span><span class="dv">\${r.volMeanDb} dB</span></div>
      </div>
      <p style="font-size:0.8em;color:var(--dim);margin:8px 0 4px">Volume per segment (5 equal parts):</p>
      <div class="vol-chart">\${volBars}</div>
      <div style="display:flex;justify-content:space-between;font-size:0.7em;color:var(--dim)">
        \${(r.segVols||[]).map((v,i) => '<span>'+v+'dB</span>').join('')}
      </div>
    </div>

    <div class="d-section">
      <h3>⏸ Pause Analysis</h3>
      <div class="d-grid">
        <div class="d-item"><span class="dk">Pause Count</span><span class="dv">\${r.pauseCount}</span></div>
        <div class="d-item"><span class="dk">Total Pause</span><span class="dv">\${r.pauseTotalSec}s</span></div>
        <div class="d-item"><span class="dk">Avg Pause</span><span class="dv">\${r.pauseAvgSec}s</span></div>
        <div class="d-item"><span class="dk">Max Pause</span><span class="dv">\${r.pauseMaxSec}s</span></div>
      </div>
    </div>

    <div class="d-section">
      <h3>🏆 Composite Score</h3>
      <div class="d-item"><span class="dk">Balanced Score (lower = better)</span><span class="dv">\${sc} \${badge(parseFloat(sc), 14, 17, true)}</span></div>
      <p style="font-size:0.78em;color:var(--dim);margin-top:4px">Formula: chars/sec + (volSpread × 5). Lower means slower speech + more consistent volume.</p>
    </div>
  \`;
  m.classList.remove('hidden');
}

function closeModal() { document.getElementById('detail-modal').classList.add('hidden'); }

function renderModelSummary() {
  const c = document.getElementById('modelSummary');
  for (const m of MODELS) {
    const sub = DATA.filter(d => d.model === m);
    const avg = (fn) => (sub.reduce((s,d) => s + fn(d), 0) / sub.length).toFixed(1);
    const min = (fn) => Math.min(...sub.map(fn)).toFixed(1);
    const max = (fn) => Math.max(...sub.map(fn)).toFixed(1);
    const d = document.createElement('div');
    d.className = 'ms-card';
    d.innerHTML = \`
      <h3>\${shortModel(m)}</h3>
      <div class="stat"><span class="k">Samples</span><span class="v">\${sub.length}</span></div>
      <div class="stat"><span class="k">Avg Duration</span><span class="v">\${avg(d=>d.durationSec)}s</span></div>
      <div class="stat"><span class="k">Avg Chars/sec</span><span class="v">\${avg(d=>d.charsPerSec)}</span></div>
      <div class="stat"><span class="k">Range Chars/sec</span><span class="v">\${min(d=>d.charsPerSec)} – \${max(d=>d.charsPerSec)}</span></div>
      <div class="stat"><span class="k">Avg Vol Spread</span><span class="v">\${avg(d=>d.volSpreadDb)} dB</span></div>
      <div class="stat"><span class="k">Avg Gen Time</span><span class="v">\${avg(d=>d.genTimeMs)}ms</span></div>
    \`;
    c.appendChild(d);
  }
}

function renderTopPicks() {
  const sorted = k => [...DATA].sort((a,b) => a[k] - b[k]);
  const slowest = sorted('charsPerSec')[0];
  const consistent = sorted('volSpreadDb')[0];
  const balanced = [...DATA].sort((a,b) => score(a) - score(b))[0];
  const fastest = sorted('charsPerSec').reverse()[0];

  fillTop('topSlowest', '🐢 Slowest', slowest, slowest.charsPerSec + ' c/s');
  fillTop('topConsistent', '🎯 Most Consistent', consistent, consistent.volSpreadDb + ' dB');
  fillTop('topBalanced', '🏆 Best Balanced', balanced, score(balanced).toFixed(1) + ' score');
  fillTop('topFastest', '⚡ Fastest Gen', [...DATA].sort((a,b)=>a.genTimeMs-b.genTimeMs)[0],
    [...DATA].sort((a,b)=>a.genTimeMs-b.genTimeMs)[0].genTimeMs + 'ms');
}

function fillTop(id, title, r, val) {
  const c = document.getElementById(id);
  const spd = r.speed === null ? 'def' : r.speed;
  c.innerHTML = \`
    <h3>\${title}</h3>
    <div class="val">\${val}</div>
    <div class="detail">\${shortModel(r.model)} · st=\${r.stability} sm=\${r.similarity} sp=\${spd}</div>
    <div class="detail">\${r.durationSec}s · \${r.charsPerSec}c/s · \${r.volSpreadDb}dB · \${r.pauseCount}p</div>
    <audio controls preload="none" src="\${r.audio}"></audio>
  \`;
  c.onclick = (e) => { if (e.target.tagName !== 'AUDIO') showDetail(r); };
}

// ── Helpers ──
function el(tag, text) { const e = document.createElement(tag); e.textContent = text; return e; }
function shortModel(m) { return m.replace('eleven_','').replace('multilingual_','ml_'); }
function modelClass(m) { return m.includes('v3') ? 'm-v3' : m.includes('flash') ? 'm-flash' : 'm-v2'; }
function pctInRange(v, min, max) { return Math.max(0, Math.min(100, ((v-min)/(max-min))*100)); }
function badge(v, good, bad, lowerBetter) {
  if (lowerBetter) return v <= good ? '<span class="badge good">excellent</span>' :
    v <= bad ? '<span class="badge mid">good</span>' : '<span class="badge bad">high</span>';
  return v >= good ? '<span class="badge good">excellent</span>' :
    v >= bad ? '<span class="badge mid">good</span>' : '<span class="badge bad">low</span>';
}

init();
`;
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  const runDir = resolveRunDir();
  const metaFile = path.join(runDir, "run.json");
  const meta = fs.existsSync(metaFile)
    ? JSON.parse(fs.readFileSync(metaFile, "utf8"))
    : { runName: path.basename(runDir) };
  const data = loadData(runDir);
  if (!data.length) { console.error("No successful results to report."); process.exit(1); }
  const html = generateHTML(data, meta);
  const out = path.join(runDir, "report.html");
  fs.writeFileSync(out, html);
  console.log(`Report: ${path.relative(ROOT, out)} (${(html.length / 1024).toFixed(0)} KB)`);
  writeIndex(path.dirname(runDir));
}

// Landing page listing every run that has a report (served at the site root).
function writeIndex(runsDir) {
  const rows = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(runsDir, d.name, "report.html")))
    .map(d => {
      const metaFile = path.join(runsDir, d.name, "run.json");
      const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : {};
      const resFile = path.join(runsDir, d.name, "results.jsonl");
      const ok = fs.existsSync(resFile)
        ? new Set(fs.readFileSync(resFile, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(r => !r.error).map(r => r.id)).size
        : 0;
      return { name: d.name, meta, ok };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Arabic Voice Sweeps</title>
<style>body{background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:900px;margin:0 auto;padding:32px 16px}
h1{font-size:1.6em}p{color:#8b949e}a.run{display:block;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;margin:12px 0;color:inherit;text-decoration:none}
a.run:hover{border-color:#58a6ff}.n{color:#58a6ff;font-weight:600}.m{color:#8b949e;font-size:.9em;margin-top:4px}.t{margin-top:8px;line-height:1.9}</style></head>
<body><h1>🎙️ ElevenLabs Arabic TTS Parameter Sweeps</h1>
<p>Each run renders the same Arabic script across models × stability × similarity × speed, measured with ffmpeg.</p>
${rows.map(r => `<a class="run" href="${encodeURIComponent(r.name)}/report.html">
<div class="n">${esc(r.name)}</div>
<div class="m">${esc(r.meta.voice?.name)} · ${r.ok} clips · ${(r.meta.models || []).map(m => esc(m.id)).join(", ")}${r.meta.startedAt ? " · " + esc(r.meta.startedAt.slice(0, 10)) : ""}</div>
${r.meta.text ? `<div class="t" dir="rtl" lang="ar">${esc(r.meta.text)}</div>` : ""}</a>`).join("\n")}
</body></html>`;
  fs.writeFileSync(path.join(runsDir, "index.html"), html);
  console.log(`Index : ${path.relative(ROOT, path.join(runsDir, "index.html"))} (${rows.length} runs)`);
}

main();
