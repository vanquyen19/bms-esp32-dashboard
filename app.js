/* =====================================================
   BMS Pro — app.js
   ESP32 BMS Dashboard — Full Application Logic
   Connects to ESP32 REST API, renders charts/gauges,
   handles data logging, alerts, LED control & printing.
   ===================================================== */

'use strict';

// ============================================================
//  CONFIG  — update ESP32_IP when deploying to real hardware
// ============================================================
const CFG = {
  ESP32_IP:    localStorage.getItem('bms_ip')   || '192.168.1.100',
  POLL_MS:     parseInt(localStorage.getItem('bms_poll') || '1000'),
  DEMO_MODE:   true,   // set false when real ESP32 is ready
  MAX_RT_PTS:  60,     // realtime chart points
  CELL_COUNT:  10,
  CELL_V_MIN:  2.8,
  CELL_V_MAX:  4.2,
  CELL_V_NOM:  3.7,
};

// ============================================================
//  STATE
// ============================================================
const STATE = {
  connected:    false,
  polling:      null,
  datalog: {
    running:    false,
    interval:   null,
    records:    [],
    startTime:  null,
    page:       1,
    pageSize:   20,
  },
  alerts:       [],
  alertCount:   0,
  thresholds: {
    cellMin:    2.8,
    cellMax:    4.2,
    currentMax: 20,
    tempMax:    60,
    socMin:     10,
    cusum:      5.0,
  },
  // Last known data
  data: {
    voltage:  0, current: 0, soc: 0, soh: 0, temp: 0, power: 0,
    cells:    Array(10).fill(null).map((_,i) => ({
      v: 3.7 + (Math.random()-0.5)*0.1,
      r: 20 + Math.random()*10,
      pct: 80 + Math.random()*15,
      status: 'ok',
    })),
    aekf:     { soc: 0, r0: 0, p: 0, lambda: 0, rNoise: 0, qNoise: 0 },
    cusum:    Array(10).fill(0),
    system:   { fw:'v1.0.0', chip:'SH367309 OK', uptime:0, heap:180, rssi:-55, ip:'--', records:0, flash:'0 KB' },
    led:      { ok:true, warn:false, err:false, charge:false },
  },
  charts: {},
  rtData: { labels:[], voltage:[], current:[], temp:[] },
  longtermData: [],
};

// ============================================================
//  INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initClock();
  buildCellGrids();
  buildCUSUMRows();
  initCharts();
  initDatalog();
  initAlerts();
  initSettings();
  initPrint();
  startPolling();
  restoreSettings();
  showToast('🔌 Đang kết nối ESP32...', 'warn');
});

// ============================================================
//  NAVIGATION
// ============================================================
const PAGE_TITLES = {
  dashboard:  'Dashboard Tổng Quan',
  cells:      'Chi Tiết 10 Ô Pin — SH367309',
  datalog:    'Thu Thập Dữ Liệu Dài Hạn',
  algorithms: 'Thuật Toán AEKF & CUSUM',
  alerts:     'Nhật Ký Cảnh Báo',
  settings:   'Cài Đặt Hệ Thống',
};

function initNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      switchTab(item.dataset.tab);
    });
  });

  document.getElementById('menu-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
}

function switchTab(tab) {
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
  const navEl = document.getElementById(`nav-${tab}`);
  if (navEl) navEl.classList.add('active');
  const tabEl = document.getElementById(`tab-${tab}`);
  if (tabEl) tabEl.classList.add('active');
  document.getElementById('page-title').textContent = PAGE_TITLES[tab] || tab;

  // Resize charts if needed
  setTimeout(() => {
    Object.values(STATE.charts).forEach(c => { if (c && c.resize) c.resize(); });
  }, 100);
}

// ============================================================
//  CLOCK
// ============================================================
function initClock() {
  const el = document.getElementById('topbar-clock');
  function tick() {
    const now = new Date();
    el.textContent = now.toLocaleTimeString('vi-VN');
  }
  tick();
  setInterval(tick, 1000);
}

// ============================================================
//  ESP32 POLLING
// ============================================================
function startPolling() {
  if (STATE.polling) clearInterval(STATE.polling);
  STATE.polling = setInterval(fetchData, CFG.POLL_MS);
  fetchData();
}

async function fetchData() {
  if (CFG.DEMO_MODE) {
    simulateData();
    return;
  }
  try {
    const res = await fetch(`http://${CFG.ESP32_IP}/api/data`, { signal: AbortSignal.timeout(2000) });
    const json = await res.json();
    applyData(json);
    setConnected(true);
  } catch (e) {
    setConnected(false);
  }
}

function setConnected(ok) {
  STATE.connected = ok;
  const dot   = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  if (ok) {
    dot.className   = 'status-dot connected';
    label.textContent = 'Đã kết nối';
  } else {
    dot.className   = 'status-dot disconnected';
    label.textContent = 'Mất kết nối!';
  }
}

// ============================================================
//  DEMO SIMULATION  — realistic BMS data
// ============================================================
let _simT = 0;
let _simSOC = 88;
let _simSOH = 96;

function simulateData() {
  _simT += 1;
  _simSOC = Math.max(10, _simSOC - 0.008 + (Math.random()-0.6)*0.05);
  const hasAnomaly = _simT > 120 && _simT < 180; // Cell 3 anomaly window

  const cells = Array(CFG.CELL_COUNT).fill(null).map((_, i) => {
    const base = 2.8 + (_simSOC / 100) * 1.4;
    const noise = (Math.random() - 0.5) * 0.025;
    const anomaly = (hasAnomaly && i === 2) ? -0.18 : 0;
    const v = parseFloat((base + noise + anomaly).toFixed(3));
    const r = parseFloat((18 + Math.random() * 6 + (hasAnomaly && i === 2 ? 15 : 0)).toFixed(1));
    const pct = parseFloat(((v - 2.8) / 1.4 * 100).toFixed(1));
    let status = 'ok';
    if (v < CFG.thresholds?.cellMin || v > CFG.thresholds?.cellMax) status = 'danger';
    else if (v < 3.1 || v > 4.1) status = 'warn';
    return { v, r, pct: Math.min(100, Math.max(0, pct)), status };
  });

  const voltage = parseFloat(cells.reduce((s, c) => s + c.v, 0).toFixed(2));
  const current = parseFloat((3 + Math.sin(_simT / 10) * 2 + Math.random()).toFixed(2));
  const temp    = parseFloat((28 + Math.sin(_simT / 30) * 4 + Math.random()).toFixed(1));
  const power   = parseFloat((voltage * current).toFixed(1));
  const soc     = parseFloat(_simSOC.toFixed(1));
  const soh     = parseFloat((_simSOH - _simT * 0.0005).toFixed(1));

  const cusum = cells.map((c, i) => {
    const expected = voltage / CFG.CELL_COUNT;
    const diff = Math.abs(c.v - expected);
    return parseFloat(Math.min(10, diff * 40 + (hasAnomaly && i === 2 ? 4 : 0)).toFixed(2));
  });

  // Auto alerts
  if (hasAnomaly && !STATE.alerts.find(a => a.msg.includes('Cell 3') && a.type === 'error')) {
    addAlert('error', '⚠ CUSUM phát hiện: Cell 3 có điện áp bất thường — kiểm tra ngay!');
  }
  if (soc < 15 && !STATE.alerts.find(a => a.msg.includes('SOC thấp'))) {
    addAlert('warning', `🔋 SOC thấp: ${soc}% — cần sạc pin sớm`);
  }

  const data = {
    voltage, current, soc, soh, temp, power, cells,
    aekf: {
      soc:    parseFloat(soc.toFixed(2)),
      r0:     parseFloat((22 + Math.random()*2).toFixed(1)),
      p:      parseFloat((0.001 + Math.random()*0.001).toFixed(5)),
      lambda: parseFloat((0.98 + Math.random()*0.01).toFixed(4)),
      rNoise: parseFloat((0.0001 + Math.random()*0.00005).toFixed(6)),
      qNoise: parseFloat((1e-5 + Math.random()*1e-6).toFixed(8)),
    },
    cusum,
    system: {
      fw: 'v1.2.3', chip: 'SH367309 OK',
      uptime: _simT,
      heap:   Math.round(180 - _simT * 0.01),
      rssi:   -55 + Math.round(Math.random()*5),
      ip:     '192.168.1.100',
      records: STATE.datalog.records.length,
      flash:  `${(STATE.datalog.records.length * 0.12).toFixed(1)} KB`,
    },
    led: {
      ok:     soc > 20 && cells.every(c => c.status === 'ok'),
      warn:   soc < 20 || cells.some(c => c.status === 'warn'),
      err:    cells.some(c => c.status === 'danger'),
      charge: false,
    },
  };

  setConnected(true);
  applyData(data);
}

// ============================================================
//  APPLY DATA  — update all UI components
// ============================================================
function applyData(d) {
  STATE.data = { ...STATE.data, ...d };
  const D = STATE.data;

  // KPI cards
  setValue('kv-voltage', D.voltage.toFixed(1));
  setValue('kv-current', D.current.toFixed(2));
  setValue('kv-soc',     D.soc.toFixed(1));
  setValue('kv-soh',     D.soh.toFixed(1));
  setValue('kv-temp',    D.temp.toFixed(1));
  setValue('kv-power',   D.power.toFixed(0));

  colorKPI('kpi-soc',  D.soc,  { dangerLow: 10, warnLow: 20 });
  colorKPI('kpi-temp', D.temp, { warnHigh: 45, dangerHigh: 60 });
  colorKPI('kpi-soh',  D.soh,  { dangerLow: 70, warnLow: 85 });

  // Realtime chart data
  const now = new Date().toLocaleTimeString('vi-VN', { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
  pushRT(STATE.rtData.labels,  now,       CFG.MAX_RT_PTS);
  pushRT(STATE.rtData.voltage, D.voltage, CFG.MAX_RT_PTS);
  pushRT(STATE.rtData.current, D.current, CFG.MAX_RT_PTS);
  pushRT(STATE.rtData.temp,    D.temp,    CFG.MAX_RT_PTS);

  updateRealtimeChart();
  updateTempChart();

  // Gauges
  drawGauge('gauge-soc',  D.soc,  100, 'gauge-soc-label',  `${D.soc.toFixed(1)}%`, socColor(D.soc));
  drawGauge('gauge-soh',  D.soh,  100, 'gauge-soh-label',  `${D.soh.toFixed(1)}%`, sohColor(D.soh));
  drawGauge('gauge-temp', D.temp, 80,  'gauge-temp-label', `${D.temp.toFixed(1)}°C`, tempColor(D.temp));

  document.getElementById('soc-meta').textContent = `Ước tính: ${(D.soc * 0.12).toFixed(2)} Ah còn lại / 12 Ah`;
  document.getElementById('soh-meta').textContent = sohLabel(D.soh);
  document.getElementById('temp-meta').textContent = `Giới hạn an toàn: 60°C | Hiện tại: ${D.temp.toFixed(1)}°C`;

  // LED indicators
  updateLEDs(D.led);

  // Cells
  updateCellMini(D.cells);
  updateCellGrid(D.cells);
  updateCellCharts(D.cells);

  // AEKF
  updateAEKF(D.aekf);

  // CUSUM
  updateCUSUM(D.cusum);

  // System info
  updateSysInfo(D.system);

  // Datalog recording
  if (STATE.datalog.running) {
    const rec = {
      ts: new Date().toISOString(),
      v: D.voltage, i: D.current, t: D.temp,
      soc: D.soc, soh: D.soh,
      cells: D.cells.map(c => c.v),
      status: D.led.err ? 'ERROR' : D.led.warn ? 'WARN' : 'OK',
    };
    STATE.datalog.records.push(rec);
    updateDatalongUI();
    updateDLTable();
    updateLongtermChart();
  }
}

function setValue(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function pushRT(arr, val, max) {
  arr.push(val);
  if (arr.length > max) arr.shift();
}

function colorKPI(id, val, { dangerLow, warnLow, warnHigh, dangerHigh } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('warn', 'danger', 'ok');
  if ((dangerLow !== undefined && val < dangerLow) ||
      (dangerHigh !== undefined && val > dangerHigh)) {
    el.classList.add('danger');
  } else if ((warnLow !== undefined && val < warnLow) ||
             (warnHigh !== undefined && val > warnHigh)) {
    el.classList.add('warn');
  } else {
    el.classList.add('ok');
  }
}

// ============================================================
//  GAUGE CANVAS RENDERER
// ============================================================
function drawGauge(canvasId, value, maxVal, labelId, labelText, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2, r = Math.min(W, H) * 0.42;
  const startAngle = Math.PI * 0.75;
  const endAngle   = Math.PI * 2.25;
  const pct        = Math.min(1, Math.max(0, value / maxVal));
  const fillAngle  = startAngle + pct * (endAngle - startAngle);

  ctx.clearRect(0, 0, W, H);

  // Track
  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, endAngle);
  ctx.lineWidth = 14;
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineCap = 'round';
  ctx.stroke();

  // Fill
  const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
  grad.addColorStop(0, color + 'aa');
  grad.addColorStop(1, color);
  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, fillAngle);
  ctx.lineWidth = 14;
  ctx.strokeStyle = grad;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Glow tick
  if (pct > 0) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(fillAngle);
    ctx.beginPath();
    ctx.arc(r, 0, 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.fill();
    ctx.restore();
  }

  if (labelId) setValue(labelId, labelText);
}

function socColor(v)  { return v > 30 ? '#22ff88' : v > 15 ? '#ffd600' : '#ff3d5a'; }
function sohColor(v)  { return v > 85 ? '#22ff88' : v > 70 ? '#ffd600' : '#ff3d5a'; }
function tempColor(v) { return v < 40 ? '#00e5c8' : v < 55 ? '#ffd600' : '#ff3d5a'; }
function sohLabel(v)  { return v > 90 ? 'Rất tốt — Pin mới' : v > 80 ? 'Tốt' : v > 70 ? 'Cần theo dõi' : 'Pin đã chai — Thay mới'; }

// ============================================================
//  LED INDICATORS
// ============================================================
function updateLEDs(led) {
  const map = { ok: 'green', warn: 'yellow', err: 'red', charge: 'blue' };
  let activeText = 'Bình thường ✅';

  Object.entries(map).forEach(([key, cls]) => {
    const el = document.getElementById(`led-${key}`);
    if (!el) return;
    if (led[key]) {
      el.classList.add('active');
      if (key === 'err')    activeText = '🔴 NGUY HIỂM — Kiểm tra ngay!';
      else if (key === 'warn' && key !== 'err') activeText = '🟡 Cảnh báo — Theo dõi pin';
    } else {
      el.classList.remove('active');
    }
  });

  setValue('led-status-text', activeText);
}

// ============================================================
//  CELLS
// ============================================================
function buildCellGrids() {
  // Mini grid
  const mini = document.getElementById('cell-mini-grid');
  mini.innerHTML = '';
  for (let i = 0; i < CFG.CELL_COUNT; i++) {
    const div = document.createElement('div');
    div.className = 'cell-mini';
    div.id = `cell-mini-${i}`;
    div.onclick = () => switchTab('cells');
    div.innerHTML = `
      <div class="cell-mini-label">C${String(i+1).padStart(2,'0')}</div>
      <div class="cell-mini-val" id="cm-v-${i}">-.--V</div>
      <div class="cell-mini-pct" id="cm-p-${i}">--%</div>`;
    mini.appendChild(div);
  }

  // Full grid
  const grid = document.getElementById('cell-grid');
  grid.innerHTML = '';
  for (let i = 0; i < CFG.CELL_COUNT; i++) {
    const div = document.createElement('div');
    div.className = 'cell-card';
    div.id = `cell-card-${i}`;
    div.innerHTML = `
      <div class="cell-header">
        <span class="cell-num">Cell ${String(i+1).padStart(2,'0')}</span>
        <span class="cell-status-badge ok" id="cell-badge-${i}">OK</span>
      </div>
      <div class="cell-voltage" id="cell-v-${i}">-.-<span class="cell-voltage-unit">V</span></div>
      <div class="cell-bar-wrap"><div class="cell-bar" id="cell-bar-${i}" style="width:50%"></div></div>
      <div class="cell-meta-row">
        <span id="cell-pct-${i}">--% SOC</span>
        <span class="cell-resist" id="cell-r-${i}">-- mΩ</span>
      </div>`;
    grid.appendChild(div);
  }
}

function updateCellMini(cells) {
  cells.forEach((c, i) => {
    const el  = document.getElementById(`cell-mini-${i}`);
    const vEl = document.getElementById(`cm-v-${i}`);
    const pEl = document.getElementById(`cm-p-${i}`);
    if (!el) return;
    el.className = `cell-mini ${c.status}`;
    if (vEl) vEl.textContent = `${c.v.toFixed(3)}V`;
    if (pEl) pEl.textContent = `${c.pct.toFixed(0)}%`;
  });
}

function updateCellGrid(cells) {
  cells.forEach((c, i) => {
    const card  = document.getElementById(`cell-card-${i}`);
    const vEl   = document.getElementById(`cell-v-${i}`);
    const barEl = document.getElementById(`cell-bar-${i}`);
    const pctEl = document.getElementById(`cell-pct-${i}`);
    const rEl   = document.getElementById(`cell-r-${i}`);
    const badge = document.getElementById(`cell-badge-${i}`);
    if (!card) return;

    card.className = `cell-card ${c.status}`;
    if (vEl) vEl.innerHTML = `${c.v.toFixed(3)}<span class="cell-voltage-unit">V</span>`;
    const barPct = ((c.v - CFG.CELL_V_MIN) / (CFG.CELL_V_MAX - CFG.CELL_V_MIN) * 100).toFixed(0);
    if (barEl) barEl.style.width = `${Math.max(0, Math.min(100, barPct))}%`;
    if (pctEl) pctEl.textContent = `${c.pct.toFixed(1)}% SOC`;
    if (rEl)   rEl.textContent   = `${c.r.toFixed(1)} mΩ`;
    if (badge) {
      badge.className = `cell-status-badge ${c.status}`;
      badge.textContent = c.status === 'ok' ? 'OK' : c.status === 'warn' ? 'CẢNH BÁO' : 'LỖI';
    }
  });
}

// ============================================================
//  CHARTS (Vanilla Canvas — no external lib needed)
// ============================================================
function initCharts() {
  STATE.charts.realtime   = createLineChart('chart-realtime', ['Điện áp (V)', 'Dòng xả (A)'], ['#00e5c8', '#ff7c38']);
  STATE.charts.temp       = createLineChart('chart-temp',     ['Nhiệt độ (°C)'],             ['#b26cff']);
  STATE.charts.cells      = createBarChart('chart-cells');
  STATE.charts.resistance = createBarChart('chart-resistance');
  STATE.charts.aekf       = createLineChart('chart-aekf',     ['SOC thực (AEKF)'],           ['#00e5c8']);
  STATE.charts.cusum      = createLineChart('chart-cusum',    ['CUSUM Max'],                  ['#ff3d5a']);
  STATE.charts.longterm   = createLineChart('chart-longterm', ['SOC (%)'],                    ['#22ff88']);
}

// Minimal canvas chart implementations
function createLineChart(id, seriesNames, colors) {
  const canvas = document.getElementById(id);
  if (!canvas) return null;
  return { canvas, ctx: canvas.getContext('2d'), seriesNames, colors, series: seriesNames.map(() => []), labels: [] };
}

function createBarChart(id) {
  const canvas = document.getElementById(id);
  if (!canvas) return null;
  return { canvas, ctx: canvas.getContext('2d'), data: [], labels: [] };
}

function updateRealtimeChart() {
  const ch = STATE.charts.realtime;
  if (!ch) return;
  ch.labels = [...STATE.rtData.labels];
  ch.series = [
    [...STATE.rtData.voltage],
    [...STATE.rtData.current],
  ];
  renderLineChart(ch);
}

function updateTempChart() {
  const ch = STATE.charts.temp;
  if (!ch) return;
  ch.labels = [...STATE.rtData.labels];
  ch.series = [[...STATE.rtData.temp]];
  renderLineChart(ch);
}

function updateCellCharts(cells) {
  const bc = STATE.charts.cells;
  if (bc) {
    bc.labels = cells.map((_, i) => `C${i+1}`);
    bc.data   = cells.map(c => c.v);
    bc.minVal = 2.5; bc.maxVal = 4.4;
    renderBarChart(bc, '#00e5c8', '#ff3d5a', 3.0, 4.15);
  }

  const rc = STATE.charts.resistance;
  if (rc) {
    rc.labels = cells.map((_, i) => `C${i+1}`);
    rc.data   = cells.map(c => c.r);
    rc.minVal = 0; rc.maxVal = 60;
    renderBarChart(rc, '#b26cff', '#ff3d5a', 0, 40);
  }
}

function updateAEKF(a) {
  setValue('aekf-soc',    `${a.soc.toFixed(2)} %`);
  setValue('aekf-r0',     `${a.r0.toFixed(2)} mΩ`);
  setValue('aekf-p',      a.p.toFixed(6));
  setValue('aekf-lambda', a.lambda.toFixed(4));
  setValue('aekf-rnoise', a.rNoise.toFixed(7));
  setValue('aekf-qnoise', a.qNoise.toFixed(8));

  // Push to AEKF chart
  const ch = STATE.charts.aekf;
  if (ch) {
    const now = new Date().toLocaleTimeString('vi-VN', { hour12:false });
    pushRT(ch.labels,    now,    CFG.MAX_RT_PTS);
    if (!ch.series[0]) ch.series[0] = [];
    pushRT(ch.series[0], a.soc,  CFG.MAX_RT_PTS);
    renderLineChart(ch);
  }
}

// ============================================================
//  CUSUM
// ============================================================
function buildCUSUMRows() {
  const container = document.getElementById('cusum-cells');
  if (!container) return;
  container.innerHTML = '';
  for (let i = 0; i < CFG.CELL_COUNT; i++) {
    const div = document.createElement('div');
    div.className = 'cusum-row';
    div.innerHTML = `
      <span class="cusum-label">C${String(i+1).padStart(2,'0')}</span>
      <div class="cusum-bar-wrap"><div class="cusum-bar" id="cusum-bar-${i}" style="width:0%"></div></div>
      <span class="cusum-val" id="cusum-val-${i}">0.00</span>`;
    container.appendChild(div);
  }
}

function updateCUSUM(scores) {
  const threshold = STATE.thresholds.cusum;
  let maxScore = 0;

  scores.forEach((s, i) => {
    maxScore = Math.max(maxScore, s);
    const pct    = Math.min(100, s / threshold * 100);
    const barEl  = document.getElementById(`cusum-bar-${i}`);
    const valEl  = document.getElementById(`cusum-val-${i}`);
    if (barEl) {
      barEl.style.width = `${pct}%`;
      barEl.className   = `cusum-bar ${s >= threshold ? 'danger' : s >= threshold * 0.7 ? 'warn' : ''}`;
    }
    if (valEl) valEl.textContent = s.toFixed(2);
  });

  // CUSUM chart
  const ch = STATE.charts.cusum;
  if (ch) {
    const now = new Date().toLocaleTimeString('vi-VN', { hour12:false });
    pushRT(ch.labels,    now,      CFG.MAX_RT_PTS);
    if (!ch.series[0]) ch.series[0] = [];
    pushRT(ch.series[0], maxScore, CFG.MAX_RT_PTS);
    renderLineChart(ch);
  }
}

// ============================================================
//  CHART RENDERERS (Canvas2D)
// ============================================================
function renderLineChart(ch) {
  const canvas = ch.canvas;
  const ctx    = ch.ctx;
  if (!canvas || !ctx) return;

  const W = canvas.offsetWidth || 400;
  const H = canvas.offsetHeight || 180;
  canvas.width  = W;
  canvas.height = H;

  const PAD = { top: 20, right: 20, bottom: 30, left: 48 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top  - PAD.bottom;

  ctx.clearRect(0, 0, W, H);

  if (!ch.series || ch.series.length === 0) return;
  const allVals = ch.series.flat().filter(v => v !== undefined);
  if (allVals.length === 0) return;

  const minV = Math.min(...allVals) - Math.abs(Math.min(...allVals)) * 0.05;
  const maxV = Math.max(...allVals) + Math.abs(Math.max(...allVals)) * 0.05;
  const range = maxV - minV || 1;

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const y = PAD.top + (g / 4) * cH;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cW, y); ctx.stroke();
    // Y label
    const val = maxV - (g / 4) * range;
    ctx.fillStyle = 'rgba(123,146,181,0.8)';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(val.toFixed(1), PAD.left - 6, y + 4);
  }

  // Series
  ch.series.forEach((series, si) => {
    if (!series || series.length < 2) return;
    const color = ch.colors[si] || '#00e5c8';
    const pts = series.map((v, i) => ({
      x: PAD.left + (i / (series.length - 1)) * cW,
      y: PAD.top  + (1 - (v - minV) / range) * cH,
    }));

    // Area fill
    const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + cH);
    grad.addColorStop(0, color + '33');
    grad.addColorStop(1, color + '00');
    ctx.beginPath();
    ctx.moveTo(pts[0].x, PAD.top + cH);
    pts.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(pts[pts.length - 1].x, PAD.top + cH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin  = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur  = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Last point dot
    const last = pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });
}

function renderBarChart(ch, colorNorm, colorDanger, warnLow, warnHigh) {
  const canvas = ch.canvas;
  const ctx    = ch.ctx;
  if (!canvas || !ctx || !ch.data.length) return;

  const W = canvas.offsetWidth || 400;
  const H = canvas.offsetHeight || 200;
  canvas.width  = W;
  canvas.height = H;

  const PAD   = { top: 20, right: 20, bottom: 30, left: 48 };
  const cW    = W - PAD.left - PAD.right;
  const cH    = H - PAD.top  - PAD.bottom;
  const minV  = ch.minVal ?? 0;
  const maxV  = ch.maxVal ?? Math.max(...ch.data) * 1.1;
  const range = maxV - minV || 1;
  const n     = ch.data.length;
  const barW  = (cW / n) * 0.65;
  const gap   = cW / n;

  ctx.clearRect(0, 0, W, H);

  // Grid & Y labels
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const y = PAD.top + (g / 4) * cH;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cW, y); ctx.stroke();
    ctx.fillStyle = 'rgba(123,146,181,0.8)';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillText((maxV - g/4*range).toFixed(1), PAD.left - 6, y + 4);
  }

  // Bars
  ch.data.forEach((v, i) => {
    const barH = ((v - minV) / range) * cH;
    const x    = PAD.left + i * gap + (gap - barW) / 2;
    const y    = PAD.top + cH - barH;

    let color = colorNorm;
    if (v > warnHigh || v < warnLow) color = colorDanger;

    const grad = ctx.createLinearGradient(x, y, x, y + barH);
    grad.addColorStop(0, color);
    grad.addColorStop(1, color + '55');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, [4, 4, 0, 0]);
    ctx.fill();

    // Label
    ctx.fillStyle = 'rgba(123,146,181,0.8)';
    ctx.font = '9px Outfit, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(ch.labels[i] || `${i+1}`, x + barW/2, PAD.top + cH + 16);
  });
}

// ============================================================
//  SYSTEM INFO
// ============================================================
function updateSysInfo(sys) {
  setValue('si-fw',      sys.fw);
  setValue('si-chip',    sys.chip);
  setValue('si-uptime',  formatUptime(sys.uptime));
  setValue('si-heap',    `${sys.heap} KB`);
  setValue('si-rssi',    `${sys.rssi} dBm`);
  setValue('si-ip',      sys.ip);
  setValue('si-records', sys.records);
  setValue('si-flash',   sys.flash);
}

function formatUptime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}h ${m}m ${s}s`;
}

// ============================================================
//  DATALOG
// ============================================================
function initDatalog() {
  document.getElementById('btn-dl-start').addEventListener('click', startDatalog);
  document.getElementById('btn-dl-stop').addEventListener('click', stopDatalog);
  document.getElementById('btn-dl-export').addEventListener('click', exportCSV);
  document.getElementById('btn-dl-export-json').addEventListener('click', exportJSON);
  document.getElementById('btn-dl-clear').addEventListener('click', clearDatalog);
  document.getElementById('dl-prev-page').addEventListener('click', () => gotoPage(-1));
  document.getElementById('dl-next-page').addEventListener('click', () => gotoPage(1));
  document.getElementById('dl-filter').addEventListener('input', updateDLTable);
  document.getElementById('dl-chart-channel').addEventListener('change', updateLongtermChart);
  document.getElementById('dl-chart-range').addEventListener('change', updateLongtermChart);
}

function startDatalog() {
  STATE.datalog.running   = true;
  STATE.datalog.startTime = Date.now();
  document.getElementById('btn-dl-start').disabled = true;
  document.getElementById('btn-dl-stop').disabled  = false;
  document.getElementById('dl-progress-wrap').style.display = '';
  showToast('📈 Bắt đầu thu thập dữ liệu', 'success');
}

function stopDatalog() {
  STATE.datalog.running = false;
  document.getElementById('btn-dl-start').disabled = false;
  document.getElementById('btn-dl-stop').disabled  = true;
  showToast(`⏹ Dừng — Đã ghi ${STATE.datalog.records.length} bản ghi`, 'warn');
}

function clearDatalog() {
  if (!confirm('Xoá toàn bộ dữ liệu đã thu thập?')) return;
  STATE.datalog.records = [];
  STATE.datalog.page    = 1;
  updateDLTable();
  updateLongtermChart();
  updateDatalongUI();
  showToast('🗑 Đã xoá dữ liệu', 'warn');
}

function updateDatalongUI() {
  const recs = STATE.datalog.records;
  setValue('dl-rec-count', `${recs.length} bản ghi`);
  if (STATE.datalog.startTime) {
    setValue('dl-elapsed', formatUptime(Math.round((Date.now() - STATE.datalog.startTime) / 1000)));
  }
  const memKB = (recs.length * 0.12).toFixed(1);
  setValue('dl-mem-used', `${memKB} KB`);
  const pct = Math.min(100, recs.length * 0.12 / 4096 * 100).toFixed(1);
  const fill = document.getElementById('dl-progress-fill');
  if (fill) fill.style.width = `${pct}%`;
}

function updateDLTable() {
  const tbody  = document.getElementById('dl-table-body');
  const filter = document.getElementById('dl-filter')?.value?.toLowerCase() || '';
  let   recs   = [...STATE.datalog.records].reverse();

  if (filter) recs = recs.filter(r => r.ts.includes(filter) || r.status.toLowerCase().includes(filter));

  const ps   = STATE.datalog.pageSize;
  const page = STATE.datalog.page;
  const total = Math.max(1, Math.ceil(recs.length / ps));
  const slice = recs.slice((page - 1) * ps, page * ps);

  setValue('dl-page-info', `Trang ${page} / ${total}`);
  document.getElementById('dl-prev-page').disabled = page <= 1;
  document.getElementById('dl-next-page').disabled = page >= total;

  if (slice.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="table-empty">Chưa có dữ liệu. Bấm "Bắt đầu thu thập".</td></tr>';
    return;
  }

  tbody.innerHTML = slice.map(r => {
    const t = new Date(r.ts).toLocaleString('vi-VN');
    const statusClass = r.status === 'ERROR' ? 'color:var(--red)' : r.status === 'WARN' ? 'color:var(--yellow)' : 'color:var(--green)';
    return `<tr>
      <td>${t}</td>
      <td>${r.v.toFixed(2)}</td>
      <td>${r.i.toFixed(2)}</td>
      <td>${r.t.toFixed(1)}</td>
      <td>${r.soc.toFixed(1)}</td>
      <td>${r.soh.toFixed(1)}</td>
      <td style="${statusClass}">${r.status}</td>
    </tr>`;
  }).join('');
}

function gotoPage(delta) {
  const recs  = STATE.datalog.records;
  const total = Math.max(1, Math.ceil(recs.length / STATE.datalog.pageSize));
  STATE.datalog.page = Math.min(total, Math.max(1, STATE.datalog.page + delta));
  updateDLTable();
}

function updateLongtermChart() {
  const channel = document.getElementById('dl-chart-channel')?.value || 'soc';
  const range   = document.getElementById('dl-chart-range')?.value  || 'all';
  const ch      = STATE.charts.longterm;
  if (!ch) return;

  let recs = [...STATE.datalog.records];
  if (range !== 'all') {
    const cutoff = Date.now() - parseInt(range) * 86400000;
    recs = recs.filter(r => new Date(r.ts).getTime() > cutoff);
  }

  // Downsample to ~60 pts
  const step   = Math.max(1, Math.floor(recs.length / 60));
  const sample = recs.filter((_, i) => i % step === 0);

  ch.labels    = sample.map(r => new Date(r.ts).toLocaleDateString('vi-VN'));
  ch.series[0] = sample.map(r => r[channel] ?? r.soc);
  ch.colors    = channel === 'temp' ? ['#b26cff'] : channel === 'current' ? ['#ff7c38'] : ['#22ff88'];
  renderLineChart(ch);
}

// Export
function exportCSV() {
  const recs = STATE.datalog.records;
  if (!recs.length) { showToast('Không có dữ liệu để xuất', 'warn'); return; }
  const header = 'Thời gian,Điện áp (V),Dòng (A),Nhiệt độ (°C),SOC (%),SOH (%),Trạng thái,' +
                 Array.from({length:10}, (_,i) => `Cell${i+1}_V`).join(',');
  const rows = recs.map(r =>
    [r.ts, r.v, r.i, r.t, r.soc, r.soh, r.status, ...r.cells.map(v => v.toFixed(3))].join(',')
  );
  downloadFile('bms_data.csv', [header, ...rows].join('\n'), 'text/csv');
  showToast('✅ Đã xuất CSV thành công', 'success');
}

function exportJSON() {
  const recs = STATE.datalog.records;
  if (!recs.length) { showToast('Không có dữ liệu để xuất', 'warn'); return; }
  downloadFile('bms_data.json', JSON.stringify(recs, null, 2), 'application/json');
  showToast('✅ Đã xuất JSON thành công', 'success');
}

function downloadFile(name, content, mime) {
  const a = document.createElement('a');
  a.href  = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name;
  a.click();
}

// ============================================================
//  ALERTS
// ============================================================
function initAlerts() {
  document.getElementById('btn-clear-alerts').addEventListener('click', () => {
    STATE.alerts = [];
    STATE.alertCount = 0;
    renderAlerts();
    setValue('alert-badge', '0');
  });

  document.getElementById('alert-filter-type').addEventListener('change', renderAlerts);
  document.getElementById('btn-save-thresholds').addEventListener('click', saveThresholds);
}

function addAlert(type, msg) {
  STATE.alerts.unshift({ type, msg, ts: new Date().toISOString() });
  STATE.alertCount++;
  setValue('alert-badge', STATE.alertCount > 99 ? '99+' : String(STATE.alertCount));
  renderAlerts();
  showToast(msg, type === 'error' ? 'error' : 'warn');
}

function renderAlerts() {
  const filter = document.getElementById('alert-filter-type')?.value || 'all';
  const list   = document.getElementById('alert-list');
  const alerts = STATE.alerts.filter(a => filter === 'all' || a.type === filter);

  if (alerts.length === 0) {
    list.innerHTML = '<div class="alert-empty">Không có cảnh báo nào. Hệ thống hoạt động bình thường ✅</div>';
    return;
  }

  const icons = { error: '🔴', warning: '🟡', info: '🔵' };
  list.innerHTML = alerts.map(a => `
    <div class="alert-entry ${a.type}">
      <div class="alert-icon">${icons[a.type] || '⚪'}</div>
      <div class="alert-body">
        <div class="alert-msg">${a.msg}</div>
        <div class="alert-time">${new Date(a.ts).toLocaleString('vi-VN')}</div>
      </div>
    </div>`).join('');
}

function saveThresholds() {
  STATE.thresholds = {
    cellMin:    parseFloat(document.getElementById('th-cell-min')?.value    || 2.8),
    cellMax:    parseFloat(document.getElementById('th-cell-max')?.value    || 4.2),
    currentMax: parseFloat(document.getElementById('th-current-max')?.value || 20),
    tempMax:    parseFloat(document.getElementById('th-temp-max')?.value    || 60),
    socMin:     parseFloat(document.getElementById('th-soc-min')?.value     || 10),
    cusum:      parseFloat(document.getElementById('th-cusum')?.value       || 5.0),
  };
  CFG.thresholds = STATE.thresholds;

  if (!CFG.DEMO_MODE) {
    fetch(`http://${CFG.ESP32_IP}/api/thresholds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(STATE.thresholds),
    }).catch(() => {});
  }
  showToast('💾 Đã lưu ngưỡng cảnh báo', 'success');
}

// ============================================================
//  SETTINGS
// ============================================================
function initSettings() {
  document.getElementById('btn-save-conn').addEventListener('click', saveConnectionSettings);
  document.getElementById('btn-refresh').addEventListener('click', () => { fetchData(); showToast('↻ Đã làm mới dữ liệu', 'success'); });
  document.getElementById('btn-export-csv').addEventListener('click', exportCSV);
  document.getElementById('btn-print').addEventListener('click', printReport);
  document.getElementById('btn-reboot').addEventListener('click', rebootESP32);
}

function saveConnectionSettings() {
  const ip   = document.getElementById('set-ip')?.value   || '192.168.1.100';
  const poll = document.getElementById('set-poll')?.value || '1000';
  CFG.ESP32_IP = ip;
  CFG.POLL_MS  = parseInt(poll);
  localStorage.setItem('bms_ip',   ip);
  localStorage.setItem('bms_poll', poll);
  startPolling();
  showToast(`💾 Đã lưu: IP=${ip} Poll=${poll}ms`, 'success');
}

function restoreSettings() {
  const ip   = localStorage.getItem('bms_ip');
  const poll = localStorage.getItem('bms_poll');
  if (ip)   document.getElementById('set-ip').value   = ip;
  if (poll) document.getElementById('set-poll').value = poll;
}

function rebootESP32() {
  if (!confirm('Khởi động lại ESP32?')) return;
  if (!CFG.DEMO_MODE) {
    fetch(`http://${CFG.ESP32_IP}/api/reboot`, { method: 'POST' }).catch(() => {});
  }
  showToast('↺ Lệnh khởi động lại đã gửi', 'warn');
}

// ============================================================
//  LED CONTROL
// ============================================================
function sendLEDCommand(channel, value) {
  if (!CFG.DEMO_MODE) {
    fetch(`http://${CFG.ESP32_IP}/api/led`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, value }),
    }).catch(() => {});
  }
  showToast(`💡 LED ${channel}: ${value}`, 'success');
}

// ============================================================
//  PRINT / REPORT
// ============================================================
function initPrint() {
  document.getElementById('btn-print-report').addEventListener('click', printReport);
  document.getElementById('btn-preview-report').addEventListener('click', previewReport);
}

function buildReportHTML() {
  const D    = STATE.data;
  const now  = new Date().toLocaleString('vi-VN');
  const title  = document.getElementById('rpt-title')?.value   || 'Báo Cáo Kiểm Tra Pin BMS';
  const project= document.getElementById('rpt-project')?.value || 'BMS 10S 36V';
  const author = document.getElementById('rpt-author')?.value  || 'Chưa điền';

  const cellsTable = D.cells.map((c, i) => `
    <tr>
      <td>Cell ${String(i+1).padStart(2,'0')}</td>
      <td>${c.v.toFixed(3)} V</td>
      <td>${c.r.toFixed(1)} mΩ</td>
      <td>${c.pct.toFixed(1)} %</td>
      <td style="color:${c.status==='ok'?'green':c.status==='warn'?'orange':'red'}">${c.status.toUpperCase()}</td>
    </tr>`).join('');

  const alertsHTML = STATE.alerts.slice(0, 20).map(a =>
    `<li style="color:${a.type==='error'?'red':a.type==='warning'?'orange':'#333'}">[${a.type.toUpperCase()}] ${a.msg} — ${new Date(a.ts).toLocaleString('vi-VN')}</li>`
  ).join('');

  return `
    <div style="font-family:Arial,sans-serif;color:#111">
      <div style="text-align:center;border-bottom:2px solid #00a896;padding-bottom:20px;margin-bottom:28px">
        <h1 style="color:#007a6e;margin:0;font-size:22px">⚡ ${title}</h1>
        <p style="margin:6px 0;color:#555">${project}</p>
        <p style="margin:2px 0;font-size:12px;color:#888">Ngày xuất: ${now} | Người thực hiện: ${author}</p>
      </div>

      <h2 style="color:#007a6e;font-size:15px;border-left:4px solid #00a896;padding-left:10px">📊 Thông Số Hệ Thống</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">
        <tr><td style="padding:6px;background:#f5f5f5;font-weight:bold;width:40%">Điện áp tổng</td><td style="padding:6px">${D.voltage.toFixed(2)} V</td></tr>
        <tr><td style="padding:6px;background:#f5f5f5;font-weight:bold">Dòng xả</td><td style="padding:6px">${D.current.toFixed(2)} A</td></tr>
        <tr><td style="padding:6px;background:#f5f5f5;font-weight:bold">Nhiệt độ</td><td style="padding:6px">${D.temp.toFixed(1)} °C</td></tr>
        <tr><td style="padding:6px;background:#f5f5f5;font-weight:bold">SOC (AEKF)</td><td style="padding:6px">${D.soc.toFixed(1)} %</td></tr>
        <tr><td style="padding:6px;background:#f5f5f5;font-weight:bold">SOH</td><td style="padding:6px">${D.soh.toFixed(1)} %</td></tr>
        <tr><td style="padding:6px;background:#f5f5f5;font-weight:bold">Công suất</td><td style="padding:6px">${D.power.toFixed(1)} W</td></tr>
      </table>

      <h2 style="color:#007a6e;font-size:15px;border-left:4px solid #00a896;padding-left:10px">🔋 Bảng Điện Áp 10 Ô Pin</h2>
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:20px">
        <thead><tr style="background:#007a6e;color:#fff">
          <th style="padding:7px;text-align:left">Ô Pin</th>
          <th style="padding:7px;text-align:left">Điện Áp</th>
          <th style="padding:7px;text-align:left">Điện Trở</th>
          <th style="padding:7px;text-align:left">SOC</th>
          <th style="padding:7px;text-align:left">Trạng Thái</th>
        </tr></thead>
        <tbody>${cellsTable}</tbody>
      </table>

      <h2 style="color:#007a6e;font-size:15px;border-left:4px solid #00a896;padding-left:10px">🧠 Tham Số Thuật Toán AEKF</h2>
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:20px">
        <tr><td style="padding:6px;background:#f5f5f5;font-weight:bold;width:40%">SOC ước lượng</td><td>${D.aekf.soc.toFixed(2)} %</td></tr>
        <tr><td style="padding:6px;background:#f5f5f5;font-weight:bold">Điện trở trong (R₀)</td><td>${D.aekf.r0.toFixed(2)} mΩ</td></tr>
        <tr><td style="padding:6px;background:#f5f5f5;font-weight:bold">Hệ số thích nghi (λ)</td><td>${D.aekf.lambda.toFixed(4)}</td></tr>
      </table>

      <h2 style="color:#007a6e;font-size:15px;border-left:4px solid #00a896;padding-left:10px">🚨 Nhật Ký Cảnh Báo (${STATE.alerts.length} mục)</h2>
      ${STATE.alerts.length > 0 ? `<ul style="font-size:12px;padding-left:20px;line-height:1.8">${alertsHTML}</ul>` : '<p style="color:#888;font-size:12px">Không có cảnh báo.</p>'}

      <h2 style="color:#007a6e;font-size:15px;border-left:4px solid #00a896;padding-left:10px">📈 Tóm Tắt Dữ Liệu Thu Thập</h2>
      <p style="font-size:12px;color:#555">Số bản ghi: <strong>${STATE.datalog.records.length}</strong> | Kích thước ước tính: <strong>${(STATE.datalog.records.length * 0.12).toFixed(1)} KB</strong></p>

      <div style="margin-top:40px;border-top:1px solid #ddd;padding-top:16px;font-size:10px;color:#aaa;text-align:center">
        BMS Pro Dashboard — ESP32 SH367309 AEKF/CUSUM | Tạo tự động ${now}
      </div>
    </div>`;
}

function previewReport() {
  const overlay = document.getElementById('print-overlay');
  const doc     = document.getElementById('print-doc');
  doc.innerHTML = buildReportHTML() +
    `<div style="margin-top:24px;text-align:center">
      <button onclick="window.print()" style="background:#007a6e;color:#fff;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:14px;margin-right:10px">🖨 In</button>
      <button onclick="document.getElementById('print-overlay').style.display='none'" style="background:#ddd;color:#333;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:14px">✕ Đóng</button>
    </div>`;
  overlay.style.display = 'flex';
}

function printReport() {
  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>BMS Report</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700&display=swap" rel="stylesheet">
    <style>body{font-family:Outfit,Arial,sans-serif;margin:40px;color:#111}</style>
    </head><body>${buildReportHTML()}</body></html>`);
  win.document.close();
  win.onload = () => { win.print(); };
}

// ============================================================
//  TOAST NOTIFICATIONS
// ============================================================
function showToast(msg, type = 'success') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success: '✅', warn: '⚠️', error: '🔴' };
  el.innerHTML = `<span>${icons[type] || '💬'}</span> <span>${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = 'all 0.3s';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// ============================================================
//  CELL SORT
// ============================================================
document.addEventListener('change', e => {
  if (e.target.id === 'cell-sort') {
    const cells = [...STATE.data.cells.map((c, i) => ({ ...c, i }))];
    switch (e.target.value) {
      case 'voltage-asc':  cells.sort((a,b) => a.v - b.v); break;
      case 'voltage-desc': cells.sort((a,b) => b.v - a.v); break;
      case 'status':       cells.sort((a,b) => ['danger','warn','ok'].indexOf(a.status) - ['danger','warn','ok'].indexOf(b.status)); break;
      default:             cells.sort((a,b) => a.i - b.i);
    }
    updateCellGrid(cells);
  }
});
