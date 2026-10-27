// ---------------------------------------------------------------------------
// Application controller. Orchestrates views, athlete management, the live
// session (device pairing, per-rider cards, trainer control), reports and
// integrations.
// ---------------------------------------------------------------------------

import { api } from './api.js';
import { WsClient } from './ws.js';
import { SmartTrainer, PowerMeter, HeartRateMonitor, SimulatedTrainer, bluetoothSupport } from './devices.js';
import { RiderCard } from './riderCard.js';
import { renderReport } from './report.js';
import { hexA } from './charts.js';
import { POWER_ZONES, configure, getSettings, ftpFactor, powerZones, hrZones, resolveLthr } from './metrics.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const PALETTE = ['#29abe2', '#e02020', '#61ce70', '#e6a23c', '#9b1fbf', '#d6336c'];
const SEND_EVERY_MS = 250; // cap on raw readings forwarded per rider
const CONTROL_REFRESH_MS = 15000; // re-send the trainer command now and then

const state = {
  users: [],
  session: null, // current public session snapshot
  editingUserId: null,
  cards: new Map(), // userId -> RiderCard
  colors: new Map(),
  devices: new Map(), // userId -> DeviceSource[] (paired in THIS browser)
  latest: new Map(), // userId -> Map(deviceId -> { kind, fields:{power:{v,ts}} })
  lastSent: new Map(),
  applied: new Map(), // userId -> { key, ts } last trainer command sent
  history: new Map(), // userId -> [[ts, power, hr]]
  wakeLock: null,
};

const support = bluetoothSupport();
const ws = new WsClient();

init();

async function init() {
  wireTabs();
  wireAthleteForm();
  wireSessionSetup();
  wireLiveControls();

  ws.addEventListener('open', () => {
    $('#wsStatus').classList.add('online');
    // After a reconnect the server has forgotten our device list: send it again.
    for (const userId of state.devices.keys()) pushDevices(userId);
  });
  ws.addEventListener('close', () => $('#wsStatus').classList.remove('online'));
  ws.addEventListener('session', (e) => onSessionMessage(e.detail.session));
  ws.addEventListener('tick', (e) => onTick(e.detail));
  ws.addEventListener('history', (e) => onHistory(e.detail));
  ws.addEventListener('sessionRemoved', () => refreshSessions());

  window.addEventListener('beforeunload', (e) => {
    if (state.session?.state === 'running' && state.devices.size) e.preventDefault();
  });
  window.addEventListener('resize', () => {
    fitRiders();
    state.cards.forEach((c) => c.redraw());
  });

  configure(await api.settings());
  applySetupDefaults();
  await Promise.all([loadUsers(), refreshSessions()]);
  loadIntegrations();
  loadHistory();
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
    state.cards.forEach((c) => c.redraw());
  });
}

// ------------------------------- athletes ----------------------------------
function wireAthleteForm() {
  $('#saveAthleteBtn').addEventListener('click', saveAthlete);
  $('#cancelEditBtn').addEventListener('click', resetAthleteForm);
  ['aFtp', 'aMaxHr', 'aLthr'].forEach((id) => $(`#${id}`).addEventListener('input', renderAthleteZonesPreview));
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
        <div class="hint">FTP ${u.ftp ?? '—'} W · Max HR ${u.maxHr ?? '—'} · LTHR ${u.lthr ?? '—'}</div>
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
  $('#aLthr').value = u.lthr ?? '';
  $('#aRestHr').value = u.restingHr ?? '';
  $('#aEmail').value = u.email ?? '';
  $('#cancelEditBtn').classList.remove('hidden');
  renderAthleteZonesPreview();
}

function resetAthleteForm() {
  state.editingUserId = null;
  $('#athleteFormTitle').textContent = 'New athlete';
  ['athleteId', 'aName', 'aWeight', 'aFtp', 'aMaxHr', 'aLthr', 'aRestHr', 'aEmail'].forEach((id) => ($(`#${id}`).value = ''));
  $('#cancelEditBtn').classList.add('hidden');
  $('#athleteZones').innerHTML = '';
}

async function saveAthlete() {
  const payload = {
    name: $('#aName').value.trim() || 'Anonymous',
    weightKg: $('#aWeight').value,
    ftp: $('#aFtp').value,
    maxHr: $('#aMaxHr').value,
    lthr: $('#aLthr').value,
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
  const maxHr = Number($('#aMaxHr').value) || null;
  const anchor = resolveLthr({ lthr: Number($('#aLthr').value) || null, maxHr });
  const box = $('#athleteZones');
  box.innerHTML = '';
  if (ftp) box.appendChild(zoneBlock('Power zones', powerZones(ftp), (z) => (z.hi === null ? `${z.lo}+ W` : `${z.lo}–${z.hi} W`)));
  if (anchor.lthr) {
    const title = `Heart-rate zones (LTHR ${anchor.lthr}${anchor.estimated ? ', estimated' : ''})`;
    box.appendChild(zoneBlock(title, hrZones(anchor.lthr, maxHr), (z) => (z.hi === null ? `${z.lo}+ bpm` : `${z.lo}–${z.hi} bpm`)));
  }
}

function zoneBlock(title, zones, fmt) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<h3>${title}</h3>`;
  for (const z of zones) {
    const row = document.createElement('div');
    row.className = 'zone-line';
    row.style.background = hexA(z.color, 0.22);
    row.style.borderLeft = `5px solid ${z.color}`;
    row.innerHTML = `<span>Z${z.zone} ${z.name}</span><span>${fmt(z)}</span>`;
    wrap.appendChild(row);
  }
  return wrap;
}

// ---------------------------- session setup --------------------------------
function applySetupDefaults() {
  const t = getSettings().test;
  $('#tWarmup').value = t.warmupMinutes;
  $('#tEffort').value = t.effortMinutes;
  $('#tEffort').min = t.minEffortMinutes;
  $('#tEffort').max = t.maxEffortMinutes;
  $('#tCooldown').value = t.cooldownMinutes;
  $('#tPercent').value = t.effortPercentFtp;
  updateFactorHint();
}

function updateFactorHint() {
  const t = getSettings().test;
  const min = Math.min(t.maxEffortMinutes, Math.max(t.minEffortMinutes, Number($('#tEffort').value) || t.effortMinutes));
  const f = ftpFactor(min);
  $('#factorHint').innerHTML = `A ${min}-minute effort uses adjustment factor <strong>× ${Number(f.toFixed(3))}</strong> (FTP = average power × ${Number(f.toFixed(3))}).`;
}

function wireSessionSetup() {
  $('#tEffort').addEventListener('input', updateFactorHint);
  $('#createSessionBtn').addEventListener('click', async () => {
    try {
      const s = await api.createSession({
        name: $('#sessName').value.trim() || 'FTP Test',
        test: {
          warmupMinutes: $('#tWarmup').value,
          effortMinutes: $('#tEffort').value,
          cooldownMinutes: $('#tCooldown').value,
          effortPercentFtp: $('#tPercent').value,
        },
      });
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
        <div class="hint">${s.test.effortMinutes}-min effort · ${s.participants.length} athlete(s) · ${s.state}</div>
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
  $('#startAllBtn').addEventListener('click', () => startSession(0));
  $('#startStaggerBtn').addEventListener('click', () => startSession(Math.max(0, Number($('#staggerSec').value) || 0)));
  $('#finishBtn').addEventListener('click', async () => {
    if (!confirm('Finish the session now? Riders still going are stopped and their results calculated.')) return;
    await api.finishSession(state.session.id).catch((e) => toast(e.message, true));
  });
  $('#leaveSessionBtn').addEventListener('click', () => {
    if (state.session?.state === 'running' && !confirm('The test is still running. Closing disconnects the devices paired in this browser. Close anyway?')) return;
    exitSession();
  });
  $('#addParticipant').addEventListener('change', async (e) => {
    const userId = e.target.value;
    e.target.value = '';
    if (!userId) return;
    if (state.session.participants.length >= 6) toast('More than 6 riders may overload the screen and Bluetooth links', true);
    await api.joinSession(state.session.id, userId).catch((err) => toast(err.message, true));
  });
}

// Start every ready rider together (stagger 0) or one after the other, in card order.
async function startSession(staggerSeconds) {
  const s = state.session;
  const ready = s.participants.filter((p) => p.state === 'ready');
  if (!ready.length) return toast('No riders are ready to start', true);
  if (!confirmStart(ready)) return;
  try {
    await api.startSession(s.id, { staggerSeconds, userIds: ready.map((p) => p.userId) });
  } catch (err) {
    toast(err.message, true);
  }
}

// Soft sanity check before starting: no devices / no FTP for %-based resistance.
function confirmStart(riders) {
  const warnings = [];
  for (const p of riders) {
    const connected = p.devices.filter((d) => d.status === 'connected');
    if (!connected.length) warnings.push(`${p.name}: no connected device`);
    else if (!connected.some((d) => d.controllable)) warnings.push(`${p.name}: no controllable trainer — resistance can't be set automatically`);
    if (p.control.mode === 'percent' && !p.ftp) warnings.push(`${p.name}: no FTP on file for % resistance`);
  }
  return !warnings.length || confirm(`Start anyway?\n\n• ${warnings.join('\n• ')}`);
}

function enterSession(session) {
  state.session = session;
  state.history.clear();
  ws.subscribe(session.id);
  $('#sessionSetup').classList.add('hidden');
  $('#sessionLive').classList.remove('hidden');
  $('#staggerSec').value = session.test.staggerSeconds;
  const banner = $('#btBanner');
  banner.classList.toggle('hidden', support.supported);
  banner.textContent = support.reason;
  requestWakeLock();
  renderParticipantPicker();
  renderSession();
}

function exitSession() {
  for (const list of state.devices.values()) list.forEach((d) => d.disconnect());
  for (const m of [state.devices, state.latest, state.lastSent, state.applied, state.history, state.cards]) m.clear();
  $('#riders').replaceChildren();
  state.session = null;
  releaseWakeLock();
  $('#sessionLive').classList.add('hidden');
  $('#sessionSetup').classList.remove('hidden');
  refreshSessions();
}

// A phone/laptop that falls asleep drops Bluetooth links, so keep the screen on.
async function requestWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    /* not supported or denied: harmless */
  }
}
function releaseWakeLock() {
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.session) requestWakeLock();
});

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
  const stateEl = $('#liveState');
  stateEl.textContent = s.state;
  stateEl.className = `pill state ${s.state}`;
  const t = s.test;
  $('#livePlan').textContent = `${t.warmupMinutes}′ warm-up · ${t.effortMinutes}′ effort (×${t.ftpFactor}) · ${t.cooldownMinutes}′ cool-down`;
  const count = (st) => s.participants.filter((p) => p.state === st).length;
  $('#liveCounts').textContent = `${count('ready')} ready · ${count('scheduled')} scheduled · ${count('running')} running · ${count('finished')} finished`;

  const finished = s.state === 'finished';
  $('#startAllBtn').disabled = finished || !count('ready');
  $('#startStaggerBtn').disabled = finished || !count('ready');
  $('#finishBtn').disabled = finished || (!count('running') && !count('scheduled'));
  $('#addParticipant').disabled = finished;

  syncCards();
  renderParticipantPicker();

  // Results live in each rider's card; the session header just offers the workbook.
  const excel = $('#excelBtn');
  excel.classList.toggle('hidden', !(finished && s.participants.some((p) => p.result)));
  excel.href = api.excelUrl(s.id);
}

// One long-lived card per rider, updated in place.
function syncCards() {
  const s = state.session;
  const wrap = $('#riders');
  const ids = new Set(s.participants.map((p) => p.userId));
  for (const [id, card] of state.cards) {
    if (!ids.has(id)) {
      card.el.remove();
      state.cards.delete(id);
    }
  }
  s.participants.forEach((p, i) => {
    let card = state.cards.get(p.userId);
    if (!card) {
      if (!state.colors.has(p.userId)) state.colors.set(p.userId, PALETTE[state.colors.size % PALETTE.length]);
      card = new RiderCard(p, state.colors.get(p.userId), cardContext());
      state.cards.set(p.userId, card);
      wrap.appendChild(card.el);
    }
    if (wrap.children[i] !== card.el) wrap.insertBefore(card.el, wrap.children[i] || null);
    card.update(p, s);
  });
  wrap.dataset.count = s.participants.length;
  fitRiders();
  $('#noRiders').classList.toggle('hidden', s.participants.length > 0);
  requestAnimationFrame(() => state.cards.forEach((c) => c.redraw()));
}

// Rider grid fills exactly the space below the session header (any screen size).
function fitRiders() {
  const wrap = $('#riders');
  const top = wrap.getBoundingClientRect().top + window.scrollY;
  wrap.style.setProperty('--riders-h', `${Math.max(0, window.innerHeight - top - 16)}px`);
}

function cardContext() {
  return {
    support,
    history: (userId) => state.history.get(userId) || [],
    isLocal: (devId) => [...state.devices.values()].some((list) => list.some((d) => d.id === devId)),
    demoEnabled: new URLSearchParams(location.search).has('demo'), // developer aid: add ?demo to the URL
    pair: (userId, kind) => pairDevice(userId, kind),
    deviceAction: (userId, devId, action) => deviceAction(userId, devId, action),
    setControl: (userId, patch) => api.setControl(state.session.id, userId, patch).catch((e) => toast(e.message, true)),
    startRider: async (userId) => {
      const p = state.session.participants.find((x) => x.userId === userId);
      if (p && !confirmStart([p])) return;
      api.startRider(state.session.id, userId).catch((e) => toast(e.message, true));
    },
    stopRider: (userId) => {
      if (confirm('Stop this rider now? Their result is calculated from what has been recorded.')) {
        api.stopRider(state.session.id, userId).catch((e) => toast(e.message, true));
      }
    },
    remove: async (userId) => {
      disconnectUser(userId);
      await api.leaveSession(state.session.id, userId);
    },
  };
}

// ------------------------------ devices ------------------------------------
const SOURCES = { trainer: () => new SmartTrainer(), power: () => new PowerMeter(), hr: () => new HeartRateMonitor() };

// NOTE: must stay synchronous up to source.pair() — Web Bluetooth only opens its
// device chooser while the click's user activation is still valid.
async function pairDevice(userId, kind) {
  const p = state.session.participants.find((x) => x.userId === userId);
  const source = kind === 'sim' ? new SimulatedTrainer(p?.ftp || 220) : SOURCES[kind]();
  if (kind !== 'sim' && !support.supported) return toast(support.reason, true);

  source.acceptDevice = (device) => {
    for (const [uid, list] of state.devices) {
      const dup = list.find((d) => d.bluetoothId === device.id);
      if (dup) return `${device.name || 'That device'} is already paired to ${nameOf(uid)}.`;
    }
    return '';
  };

  // The chip shows up immediately ("connecting…") because it is in the list from the start.
  const sameRole = (d) => d.kind === source.kind || (d.kind === 'sim' && source.kind === 'trainer') || (d.kind === 'trainer' && source.kind === 'sim');
  const prior = (state.devices.get(userId) || []).filter(sameRole);
  const drop = (dev) => {
    state.devices.set(userId, (state.devices.get(userId) || []).filter((d) => d !== dev));
    state.latest.get(userId)?.delete(dev.id);
  };
  state.devices.set(userId, [...(state.devices.get(userId) || []), source]);
  source.addEventListener('reading', (e) => onReading(userId, source, e.detail));
  source.addEventListener('status', () => onDeviceStatus(userId, source));

  try {
    await source.pair();
  } catch (err) {
    if (err.message !== 'Pairing cancelled') toast(err.message, true);
    if (source.status !== 'failed') {
      drop(source); // nothing to keep: chooser cancelled or device vetoed
      return pushDevices(userId);
    }
    // 'failed' keeps its chip so the rider can hit Retry without re-pairing.
  }

  // One device per role: a successful new pairing replaces the previous one.
  if (source.connected) {
    for (const old of prior) {
      drop(old);
      old.disconnect();
    }
    toast(`${source.name} connected`);
  }
  pushDevices(userId);
}

function deviceAction(userId, devId, action) {
  const list = state.devices.get(userId) || [];
  const dev = list.find((d) => d.id === devId);
  if (!dev) return;
  if (action === 'retry') {
    dev.reconnect?.().catch((err) => toast(err.message, true));
  } else {
    if (!confirm(`Disconnect ${dev.name || 'this device'} from ${nameOf(userId)}?`)) return;
    dev.disconnect();
    state.devices.set(userId, list.filter((d) => d !== dev));
    state.latest.get(userId)?.delete(devId);
    pushDevices(userId);
  }
}

function onDeviceStatus(userId, source) {
  if (source.connected && source.controllable) state.applied.delete(userId); // re-send the command to a (re)connected trainer
  if (source.status === 'reconnecting' && source._announced !== 'reconnecting') toast(`${source.name}: connection dropped, reconnecting…`, true);
  source._announced = source.status;
  pushDevices(userId);
}

function disconnectUser(userId) {
  (state.devices.get(userId) || []).forEach((d) => d.disconnect());
  for (const m of [state.devices, state.latest, state.lastSent, state.applied]) m.delete(userId);
}

function pushDevices(userId) {
  if (!state.session) return;
  const list = (state.devices.get(userId) || []).map((d) => d.describe());
  ws.devices(state.session.id, userId, list);
}

// Merge readings from several devices into one reading per rider: power meter
// beats trainer power, a heart-rate strap beats anything else for HR.
const PRIORITY = { power: ['power', 'trainer', 'sim'], cadence: ['power', 'trainer', 'sim'], hr: ['hr', 'trainer', 'sim'] };
const FRESH_MS = 3000;

function onReading(userId, source, reading) {
  const now = Date.now();
  let perDevice = state.latest.get(userId);
  if (!perDevice) state.latest.set(userId, (perDevice = new Map()));
  let entry = perDevice.get(source.id);
  if (!entry) perDevice.set(source.id, (entry = { kind: source.kind, fields: {} }));
  for (const [k, v] of Object.entries(reading)) entry.fields[k] = { v, ts: now };

  if (now - (state.lastSent.get(userId) || 0) < SEND_EVERY_MS) return;
  state.lastSent.set(userId, now);

  const merged = {};
  for (const [field, order] of Object.entries(PRIORITY)) {
    for (const kind of order) {
      const hit = [...perDevice.values()].find((d) => d.kind === kind && d.fields[field] && now - d.fields[field].ts < FRESH_MS);
      if (hit) {
        merged[field] = hit.fields[field].v;
        break;
      }
    }
  }
  if (Object.keys(merged).length) ws.telemetry(state.session.id, userId, merged);
}

// --------------------------- ticks & trainer control -------------------------
function onHistory({ sessionId, riders }) {
  if (sessionId !== state.session?.id) return;
  for (const [userId, points] of Object.entries(riders || {})) state.history.set(userId, points);
  state.cards.forEach((c) => c.redraw());
}

function onTick({ sessionId, ts, riders }) {
  if (sessionId !== state.session?.id) return;
  const windowMs = getSettings().history.windowSeconds * 1000;
  for (const r of riders) {
    let h = state.history.get(r.userId);
    if (!h) state.history.set(r.userId, (h = []));
    h.push([ts, r.power, r.hr]);
    while (h.length && h[0][0] < ts - windowMs) h.shift();
    state.cards.get(r.userId)?.applyTick(r);
    syncControl(r);
  }
}

// Forward the server's command (free ride / ERG watts) to this browser's trainer.
function syncControl(r) {
  const trainers = (state.devices.get(r.userId) || []).filter((d) => d.controllable && d.connected);
  if (!trainers.length) return;
  const key = JSON.stringify(r.control);
  const last = state.applied.get(r.userId);
  // Don't poke an idle trainer with "free ride" before anything has happened.
  if (!last && r.control.mode === 'free' && r.state !== 'running') {
    state.applied.set(r.userId, { key, ts: Date.now() });
    return;
  }
  if (last && last.key === key && Date.now() - last.ts < CONTROL_REFRESH_MS) return;
  state.applied.set(r.userId, { key, ts: Date.now() });
  trainers.forEach((d) => d.applyControl(r.control).catch(() => {})); // failures show up on the device chip
}

// ------------------------------- history -----------------------------------
async function loadHistory() {
  const hist = await api.tests();
  const body = $('#historyBody');
  if (!hist.length) {
    body.innerHTML = '<p class="hint">No completed tests yet.</p>';
    return;
  }
  body.innerHTML = `<table>
    <thead><tr><th>Test</th><th>Date</th><th>Effort</th><th>Riders (new FTP)</th><th></th></tr></thead>
    <tbody>${hist
      .map(
        (h) => `<tr>
        <td><strong>${escapeHtml(h.name)}</strong></td>
        <td>${new Date(h.finishedAt).toLocaleString()}</td>
        <td>${h.test ? `${h.test.effortMinutes} min · × ${h.test.ftpFactor}` : '—'}</td>
        <td>${h.results.map((r) => `${escapeHtml(r.name)} <span class="ftp-cell">${r.estimatedFtp} W</span>`).join(' · ')}</td>
        <td class="btn-row">${h.test ? `<button class="btn" data-report="${h.sessionId}">Report</button>` : ''}<button class="btn danger" data-delete="${h.sessionId}">✕</button></td>
      </tr>`,
      )
      .join('')}</tbody></table>`;
  body.onclick = async (e) => {
    const open = e.target.closest('[data-report]');
    const del = e.target.closest('[data-delete]');
    if (open) showReport(open.dataset.report);
    if (del && confirm('Delete this test and its recorded data?')) {
      await api.deleteTest(del.dataset.delete).catch((err) => toast(err.message, true));
      $('#historyReport').classList.add('hidden');
      loadHistory();
    }
  };
}

async function showReport(id) {
  try {
    const record = await api.test(id);
    const box = $('#historyReport');
    box.innerHTML = renderReport(record);
    box.classList.remove('hidden');
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    toast(err.message, true);
  }
}

// ----------------------------- integrations --------------------------------
async function loadIntegrations() {
  const status = await api.integrationStatus();
  $('#integrations').innerHTML = `
    ${integrationCard('Strava', status.strava.configured, '/api/integrations/strava/connect')}
    ${integrationCard('TrainingPeaks', status.trainingpeaks.configured, '/api/integrations/trainingpeaks/connect')}`;
}

function integrationCard(name, configured, connectUrl) {
  return `<div class="integration">
    <h3>${name} <span class="badge ${configured ? 'ok' : 'off'}">${configured ? 'ready' : 'not configured'}</span></h3>
    <p class="hint">${configured ? 'Connect your account to push finished tests.' : 'Add API credentials in .env to enable.'}</p>
    <a class="btn ${configured ? 'primary' : ''}" href="${connectUrl}" ${configured ? '' : 'aria-disabled="true"'}>Connect ${name}</a>
  </div>`;
}

// ------------------------------- helpers -----------------------------------
function nameOf(userId) {
  return state.session?.participants.find((p) => p.userId === userId)?.name || 'another rider';
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), isError ? 5000 : 2600);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
