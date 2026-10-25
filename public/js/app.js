// ---------------------------------------------------------------------------
// Application controller. Orchestrates views, athlete management, the live
// session (device connections + telemetry), results and integrations.
// ---------------------------------------------------------------------------

import { api } from './api.js';
import { WsClient } from './ws.js';
import { PowerMeter, HeartRateMonitor, SimulatedTrainer } from './devices.js';
import { powerZoneFor, hrZoneFor, feedback, fmtDuration, POWER_ZONES, HR_ZONES } from './metrics.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const state = {
  users: [],
  protocols: [],
  session: null, // current public session
  editingUserId: null,
  // Live device plumbing keyed by userId.
  devices: new Map(), // userId -> [DeviceSource]
  buffers: new Map(), // userId -> { power, hr, cadence }
  chart: new Map(), // userId -> number[] (recent power)
  colors: new Map(), // userId -> css color
};

const PALETTE = ['#4ec9b0', '#7ea6ff', '#e6a23c', '#f56c6c', '#d6336c', '#9b1fbf', '#c9d14e', '#37b5e6'];
const ws = new WsClient();

// ------------------------------- bootstrap ---------------------------------
init();

async function init() {
  wireTabs();
  wireAthleteForm();
  wireSessionSetup();
  wireLiveControls();

  ws.addEventListener('open', () => $('#wsStatus').classList.add('online'));
  ws.addEventListener('session', (e) => onSessionMessage(e.detail.session));
  ws.addEventListener('live', (e) => onLiveMessage(e.detail));
  ws.addEventListener('sessionRemoved', () => refreshSessions());

  await Promise.all([loadUsers(), loadProtocols()]);
  await refreshSessions();
  loadIntegrations();
  loadHistory();
  tickTimer();
}

// --------------------------------- tabs ------------------------------------
function wireTabs() {
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    $$('.tab').forEach((t) => t.classList.toggle('active', t === btn));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${btn.dataset.view}`));
    if (btn.dataset.view === 'history') loadHistory();
    if (btn.dataset.view === 'integrations') loadIntegrations();
  });
}

// ------------------------------- athletes ----------------------------------
function wireAthleteForm() {
  $('#saveAthleteBtn').addEventListener('click', saveAthlete);
  $('#cancelEditBtn').addEventListener('click', resetAthleteForm);
  ['aFtp', 'aMaxHr'].forEach((id) => $(`#${id}`).addEventListener('input', renderAthleteZonesPreview));
}

async function loadUsers() {
  state.users = await api.listUsers();
  renderAthleteList();
  renderParticipantPicker();
}

function renderAthleteList() {
  const ul = $('#athleteList');
  ul.innerHTML = '';
  if (!state.users.length) ul.innerHTML = '<li class="hint">No athletes yet. Add one on the left.</li>';
  for (const u of state.users) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <strong>${escapeHtml(u.name)}</strong>
        <div class="hint">FTP ${u.ftp ?? '—'} W · Max HR ${u.maxHr ?? '—'}</div>
      </div>
      <div class="btn-row">
        <button class="btn" data-edit="${u.id}">Edit</button>
        <button class="btn danger" data-del="${u.id}">✕</button>
      </div>`;
    ul.appendChild(li);
  }
  ul.onclick = async (e) => {
    const edit = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-del]');
    if (edit) editAthlete(edit.dataset.edit);
    if (del) {
      await api.deleteUser(del.dataset.del);
      toast('Athlete removed');
      loadUsers();
    }
  };
}

function editAthlete(id) {
  const u = state.users.find((x) => x.id === id);
  if (!u) return;
  state.editingUserId = id;
  $('#athleteFormTitle').textContent = `Edit ${u.name}`;
  $('#athleteId').value = u.id;
  $('#aName').value = u.name;
  $('#aWeight').value = u.weightKg ?? '';
  $('#aFtp').value = u.ftp ?? '';
  $('#aMaxHr').value = u.maxHr ?? '';
  $('#aRestHr').value = u.restingHr ?? '';
  $('#aEmail').value = u.email ?? '';
  $('#cancelEditBtn').classList.remove('hidden');
  renderAthleteZonesPreview();
}

function resetAthleteForm() {
  state.editingUserId = null;
  $('#athleteFormTitle').textContent = 'New athlete';
  ['athleteId', 'aName', 'aWeight', 'aFtp', 'aMaxHr', 'aRestHr', 'aEmail'].forEach((id) => ($(`#${id}`).value = ''));
  $('#cancelEditBtn').classList.add('hidden');
  $('#athleteZones').innerHTML = '';
}

async function saveAthlete() {
  const payload = {
    name: $('#aName').value.trim() || 'Anonymous',
    weightKg: $('#aWeight').value,
    ftp: $('#aFtp').value,
    maxHr: $('#aMaxHr').value,
    restingHr: $('#aRestHr').value,
    email: $('#aEmail').value.trim(),
  };
  try {
    if (state.editingUserId) await api.updateUser(state.editingUserId, payload);
    else await api.createUser(payload);
    toast('Athlete saved');
    resetAthleteForm();
    loadUsers();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderAthleteZonesPreview() {
  const ftp = Number($('#aFtp').value);
  const maxHr = Number($('#aMaxHr').value);
  const box = $('#athleteZones');
  box.innerHTML = '';
  if (ftp) box.appendChild(zoneBlock('Power zones', POWER_ZONES, (z) => zoneRange(z, ftp, 'W')));
  if (maxHr) box.appendChild(zoneBlock('Heart-rate zones', HR_ZONES, (z) => zoneRange(z, maxHr, 'bpm')));
}

function zoneBlock(title, zones, fmt) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<h3>${title}</h3>`;
  for (const z of zones) {
    const row = document.createElement('div');
    row.className = 'zone-line';
    row.style.background = hexA(z.color, 0.15);
    row.innerHTML = `<span>Z${z.zone} ${z.name}</span><span>${fmt(z)}</span>`;
    wrap.appendChild(row);
  }
  return wrap;
}

function zoneRange(z, anchor, unit) {
  const lo = Math.round(z.min * anchor);
  const hi = z.max === Infinity ? '∞' : Math.round(z.max * anchor);
  return `${lo}–${hi} ${unit}`;
}

// ---------------------------- session setup --------------------------------
async function loadProtocols() {
  state.protocols = await api.protocols();
  const sel = $('#sessProtocol');
  sel.innerHTML = state.protocols.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  sel.onchange = updateProtocolHint;
  updateProtocolHint();
}

function updateProtocolHint() {
  const p = state.protocols.find((x) => x.id === $('#sessProtocol').value);
  $('#protocolHint').textContent = p ? p.description : '';
}

function wireSessionSetup() {
  $('#createSessionBtn').addEventListener('click', async () => {
    try {
      const s = await api.createSession({ name: $('#sessName').value.trim() || 'FTP Test', protocol: $('#sessProtocol').value });
      enterSession(s);
      refreshSessions();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

async function refreshSessions() {
  const list = await api.listSessions();
  const ul = $('#sessionList');
  ul.innerHTML = '';
  if (!list.length) ul.innerHTML = '<li class="hint">No open sessions.</li>';
  for (const s of list) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div><strong>${escapeHtml(s.name)}</strong>
        <div class="hint">${s.protocol} · ${s.participants.length} athlete(s) · ${s.state}</div>
      </div>
      <button class="btn" data-open="${s.id}">Open</button>`;
    ul.appendChild(li);
  }
  ul.onclick = (e) => {
    const b = e.target.closest('[data-open]');
    if (b) api.getSession(b.dataset.open).then(enterSession);
  };
}

// --------------------------- live session view -----------------------------
function wireLiveControls() {
  $('#startBtn').addEventListener('click', () => api.startSession(state.session.id).catch((e) => toast(e.message, true)));
  $('#finishBtn').addEventListener('click', () => api.finishSession(state.session.id).catch((e) => toast(e.message, true)));
  $('#leaveSessionBtn').addEventListener('click', exitSession);
  $('#addParticipant').addEventListener('change', async (e) => {
    const userId = e.target.value;
    e.target.value = '';
    if (!userId) return;
    await api.joinSession(state.session.id, userId).catch((err) => toast(err.message, true));
  });
}

function enterSession(session) {
  state.session = session;
  ws.subscribe(session.id);
  $('#sessionSetup').classList.add('hidden');
  $('#sessionLive').classList.remove('hidden');
  renderParticipantPicker();
  renderSession();
}

function exitSession() {
  // Tear down any active device connections.
  for (const list of state.devices.values()) list.forEach((d) => d.disconnect());
  state.devices.clear();
  state.buffers.clear();
  state.chart.clear();
  state.session = null;
  $('#sessionLive').classList.add('hidden');
  $('#sessionSetup').classList.remove('hidden');
  refreshSessions();
}

function onSessionMessage(session) {
  if (!state.session || session.id !== state.session.id) {
    refreshSessions();
    return;
  }
  state.session = session;
  renderSession();
}

function renderParticipantPicker() {
  const sel = $('#addParticipant');
  if (!sel) return;
  const joined = new Set((state.session?.participants || []).map((p) => p.userId));
  sel.innerHTML =
    '<option value="">+ Add athlete…</option>' +
    state.users.filter((u) => !joined.has(u.id)).map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
}

function renderSession() {
  const s = state.session;
  if (!s) return;
  $('#liveName').textContent = s.name;
  $('#liveProtocol').textContent = s.protocol;
  const stateEl = $('#liveState');
  stateEl.textContent = s.state;
  stateEl.className = `pill state ${s.state}`;
  $('#startBtn').disabled = s.state === 'running';
  $('#finishBtn').disabled = s.state !== 'running';

  assignColors();
  renderParticipants();
  renderLeaderboard();
  renderParticipantPicker();

  if (s.state === 'finished') renderResults();
  else $('#results').classList.add('hidden');
}

function assignColors() {
  state.session.participants.forEach((p, i) => {
    if (!state.colors.has(p.userId)) state.colors.set(p.userId, PALETTE[i % PALETTE.length]);
  });
}

function renderParticipants() {
  const wrap = $('#participants');
  wrap.innerHTML = '';
  for (const p of state.session.participants) {
    const color = state.colors.get(p.userId);
    const pz = powerZoneFor(p.live.power, p.ftp);
    const fb = state.session.state === 'running' ? feedback(p.live.power, p.ftp) : { text: '', tone: 'neutral' };
    const card = document.createElement('div');
    card.className = `participant ${p.deviceStatus === 'connected' ? 'connected' : ''}`;
    card.style.borderLeftColor = color;
    card.innerHTML = `
      <h3><span>${escapeHtml(p.name)}</span><span class="dot ${p.deviceStatus === 'connected' ? 'on' : ''}"></span></h3>
      <div class="metrics">
        <div class="metric"><div class="val">${p.live.power || 0}</div><div class="unit">watts</div></div>
        <div class="metric"><div class="val">${p.live.hr || 0}</div><div class="unit">bpm</div></div>
        <div class="metric"><div class="val">${p.live.cadence || 0}</div><div class="unit">rpm</div></div>
      </div>
      ${pz ? `<span class="zone-badge" style="background:${pz.color}">Z${pz.zone} ${pz.name}</span>` : ''}
      <div class="feedback ${fb.tone}">${fb.text}</div>
      <div class="dev-buttons">
        <button class="btn" data-power="${p.userId}">🔗 Power</button>
        <button class="btn" data-hr="${p.userId}">❤ HR</button>
        <button class="btn ghost" data-sim="${p.userId}">▶ Demo</button>
        <button class="btn danger" data-remove="${p.userId}">Remove</button>
      </div>`;
    wrap.appendChild(card);
  }
  wrap.onclick = onParticipantAction;
}

async function onParticipantAction(e) {
  const power = e.target.closest('[data-power]');
  const hr = e.target.closest('[data-hr]');
  const sim = e.target.closest('[data-sim]');
  const remove = e.target.closest('[data-remove]');
  try {
    if (power) await connectDevice(power.dataset.power, new PowerMeter());
    if (hr) await connectDevice(hr.dataset.hr, new HeartRateMonitor());
    if (sim) await connectDevice(sim.dataset.sim, new SimulatedTrainer(guessBasePower(sim.dataset.sim)));
    if (remove) {
      disconnectUser(remove.dataset.remove);
      await api.leaveSession(state.session.id, remove.dataset.remove);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

function guessBasePower(userId) {
  const p = state.session.participants.find((x) => x.userId === userId);
  return p?.ftp ? Math.round(p.ftp * 1.02) : 220;
}

// Wire a device source to a participant: merge its readings and stream up.
async function connectDevice(userId, source) {
  await source.connect();
  if (!state.devices.has(userId)) state.devices.set(userId, []);
  state.devices.get(userId).push(source);

  source.addEventListener('reading', (e) => {
    const buf = state.buffers.get(userId) || { power: 0, hr: 0, cadence: 0 };
    Object.assign(buf, e.detail);
    state.buffers.set(userId, buf);
    ws.telemetry(state.session.id, userId, buf);
  });
  source.addEventListener('status', (e) => {
    ws.deviceStatus(state.session.id, userId, e.detail.connected ? 'connected' : 'disconnected');
  });
  ws.deviceStatus(state.session.id, userId, 'connected');
  toast(`${source.name} connected`);
}

function disconnectUser(userId) {
  (state.devices.get(userId) || []).forEach((d) => d.disconnect());
  state.devices.delete(userId);
  state.buffers.delete(userId);
}

// Live telemetry from any client (including our own echoes).
function onLiveMessage({ userId, live }) {
  const p = state.session?.participants.find((x) => x.userId === userId);
  if (p) p.live = live;
  // Chart history buffer.
  if (!state.chart.has(userId)) state.chart.set(userId, []);
  const arr = state.chart.get(userId);
  arr.push(live.power || 0);
  if (arr.length > 300) arr.shift();
  updateLiveCards();
  drawChart();
}

// Lightweight in-place refresh of the metric numbers without full re-render.
function updateLiveCards() {
  for (const p of state.session?.participants || []) {
    const card = $(`.participant [data-power="${p.userId}"]`)?.closest('.participant');
    if (!card) continue;
    const vals = card.querySelectorAll('.metric .val');
    vals[0].textContent = p.live.power || 0;
    vals[1].textContent = p.live.hr || 0;
    vals[2].textContent = p.live.cadence || 0;
    const pz = powerZoneFor(p.live.power, p.ftp);
    const badge = card.querySelector('.zone-badge');
    if (pz && badge) {
      badge.style.background = pz.color;
      badge.textContent = `Z${pz.zone} ${pz.name}`;
    }
    const fbEl = card.querySelector('.feedback');
    if (fbEl && state.session.state === 'running') {
      const fb = feedback(p.live.power, p.ftp);
      fbEl.textContent = fb.text;
      fbEl.className = `feedback ${fb.tone}`;
    }
  }
  renderLeaderboard();
}

function renderLeaderboard() {
  const wrap = $('#leaderboard');
  if (!wrap) return;
  const ranked = [...(state.session?.participants || [])].sort((a, b) => (b.live.power || 0) - (a.live.power || 0));
  const max = Math.max(1, ...ranked.map((p) => p.live.power || 0));
  wrap.innerHTML = ranked
    .map((p, i) => {
      const color = state.colors.get(p.userId);
      const wkg = p.ftp ? '' : '';
      return `<div class="lb-row">
        <span class="lb-rank">${i + 1}</span>
        <div><strong>${escapeHtml(p.name)}</strong>
          <div class="lb-bar" style="width:${((p.live.power || 0) / max) * 100}%;background:${color}"></div>
        </div>
        <span>${p.live.power || 0} W</span>
        <span class="hint">${p.live.hr || 0} bpm ${wkg}</span>
      </div>`;
    })
    .join('');
}

// ------------------------------- chart -------------------------------------
function drawChart() {
  const canvas = $('#powerChart');
  if (!canvas || !state.session) return;
  const ctx = canvas.getContext('2d');
  const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
  const h = (canvas.height = 220 * devicePixelRatio);
  ctx.clearRect(0, 0, w, h);

  const series = state.session.participants.map((p) => ({
    color: state.colors.get(p.userId),
    data: state.chart.get(p.userId) || [],
  }));
  const maxPower = Math.max(150, ...series.flatMap((s) => s.data));
  const pad = 8 * devicePixelRatio;

  // FTP reference lines.
  ctx.strokeStyle = 'rgba(38, 50, 65, 0.08)';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const y = pad + ((h - 2 * pad) * g) / 4;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
  }

  for (const s of series) {
    if (s.data.length < 2) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2 * devicePixelRatio;
    ctx.beginPath();
    s.data.forEach((v, i) => {
      const x = pad + ((w - 2 * pad) * i) / Math.max(1, s.data.length - 1);
      const y = h - pad - ((h - 2 * pad) * v) / maxPower;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

// ------------------------------- results -----------------------------------
function renderResults() {
  const box = $('#results');
  box.classList.remove('hidden');
  const rows = state.session.participants
    .filter((p) => p.result)
    .sort((a, b) => b.result.estimatedFtp - a.result.estimatedFtp)
    .map(
      (p) => `<tr>
        <td>${escapeHtml(p.name)}</td>
        <td class="ftp-cell">${p.result.estimatedFtp} W</td>
        <td>${p.result.avgPower} W</td>
        <td>${p.result.normalizedPower} W</td>
        <td>${p.result.maxPower} W</td>
        <td>${p.result.avgHr || '—'}</td>
        <td>${p.result.maxHr || '—'}</td>
        <td>${fmtDuration(p.result.durationSec)}</td>
      </tr>`,
    )
    .join('');
  $('#resultsBody').innerHTML = `
    <table>
      <thead><tr><th>Athlete</th><th>New FTP</th><th>Avg</th><th>NP</th><th>Max</th><th>Avg HR</th><th>Max HR</th><th>Time</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="hint">No data captured.</td></tr>'}</tbody>
    </table>`;
}

// ------------------------------- history -----------------------------------
async function loadHistory() {
  const hist = await api.history();
  const body = $('#historyBody');
  if (!hist.length) {
    body.innerHTML = '<p class="hint">No completed tests yet.</p>';
    return;
  }
  body.innerHTML = hist
    .map(
      (h) => `
      <h3>${escapeHtml(h.name)} <span class="hint">— ${h.protocol} · ${new Date(h.finishedAt).toLocaleString()}</span></h3>
      <table>
        <thead><tr><th>Athlete</th><th>FTP</th><th>Avg</th><th>NP</th><th>Max HR</th></tr></thead>
        <tbody>${h.results
          .map((r) => `<tr><td>${escapeHtml(r.name)}</td><td class="ftp-cell">${r.estimatedFtp} W</td><td>${r.avgPower} W</td><td>${r.normalizedPower} W</td><td>${r.maxHr || '—'}</td></tr>`)
          .join('')}</tbody>
      </table>`,
    )
    .join('<hr style="border-color:var(--line)">');
}

// ----------------------------- integrations --------------------------------
async function loadIntegrations() {
  const status = await api.integrationStatus();
  $('#integrations').innerHTML = `
    ${integrationCard('Strava', status.strava.configured, '/api/integrations/strava/connect')}
    ${integrationCard('TrainingPeaks', status.trainingpeaks.configured, '/api/integrations/trainingpeaks/connect')}
    <div class="integration">
      <h3>Export TCX</h3>
      <p class="hint">Download the current session as a standard file any platform can import.</p>
      <button class="btn" id="exportTcx">Download TCX</button>
    </div>`;
  $('#exportTcx')?.addEventListener('click', exportTcx);
}

function integrationCard(name, configured, connectUrl) {
  return `<div class="integration">
    <h3>${name} <span class="badge ${configured ? 'ok' : 'off'}">${configured ? 'ready' : 'not configured'}</span></h3>
    <p class="hint">${configured ? 'Connect your account to push finished tests.' : 'Add API credentials in .env to enable.'}</p>
    <a class="btn ${configured ? 'primary' : ''}" href="${connectUrl}" ${configured ? '' : 'aria-disabled="true"'}>Connect ${name}</a>
  </div>`;
}

// Build a TCX client-side from the current participants' chart buffers is not
// enough (we only keep power); instead request nothing extra and export the
// leader's live buffer as a simple example the platforms accept.
function exportTcx() {
  if (!state.session) return toast('Open a session first', true);
  const p = state.session.participants[0];
  if (!p) return toast('No athletes in session', true);
  const samples = (state.chart.get(p.userId) || []).map((power, i) => ({ t: i * 1000, power }));
  const tcx = buildTcx(state.session.name, samples);
  const blob = new Blob([tcx], { type: 'application/xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.session.name.replace(/\s+/g, '_')}.tcx`;
  a.click();
}

function buildTcx(name, samples) {
  const start = new Date().toISOString();
  const pts = samples
    .map((s) => `<Trackpoint><Time>${new Date(Date.now() + s.t).toISOString()}</Time><Extensions><ns3:TPX><ns3:Watts>${Math.round(s.power)}</ns3:Watts></ns3:TPX></Extensions></Trackpoint>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2"><Activities><Activity Sport="Biking"><Id>${start}</Id><Lap StartTime="${start}"><Track>${pts}</Track></Lap><Notes>${name}</Notes></Activity></Activities></TrainingCenterDatabase>`;
}

// ------------------------------- helpers -----------------------------------
function tickTimer() {
  const el = $('#liveTimer');
  if (el && state.session?.state === 'running' && state.session.startedAt) {
    el.textContent = fmtDuration((Date.now() - state.session.startedAt) / 1000);
  }
  requestAnimationFrame(() => setTimeout(tickTimer, 250));
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
