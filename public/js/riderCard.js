// ---------------------------------------------------------------------------
// One rider's live view: paired devices (with their live power / heart rate),
// 5-minute history, zone gauges, test phase and resistance control.
// Built once per rider and updated in place so inputs never lose focus.
// ---------------------------------------------------------------------------
import { ZoneGauge, drawHistory } from './charts.js';
import { renderRiderResult } from './report.js';
import { powerZones, hrZones, resolveLthr, zoneOf, getSettings, fmtDuration } from './metrics.js';

const DEVICE_ICON = { trainer: '🚴', sim: '🧪', power: '⚡', hr: '❤️' };
const KIND_LABEL = { trainer: 'Smart trainer', sim: 'Demo trainer', power: 'Power meter', hr: 'HR strap' };
const STATUS_LABEL = {
  connected: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  failed: 'Connection lost',
  disconnected: 'Disconnected',
};
const STATE_LABEL = { ready: 'Ready', scheduled: 'Scheduled', running: 'Running', finished: 'Finished' };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class RiderCard {
  /**
   * @param ctx callbacks: { support, isLocal(devId), pair(userId, kind), demo(userId),
   *   deviceAction(userId, devId, action), setControl(userId, patch), startRider(userId),
   *   stopRider(userId), remove(userId), history(userId) }
   */
  constructor(p, color, ctx) {
    this.userId = p.userId;
    this.ctx = ctx;
    this.p = p;
    this.tick = null;
    this.zoneKey = '';
    this.el = document.createElement('article');
    this.el.className = 'rider';
    this.el.style.setProperty('--rider', color);
    this.el.innerHTML = `
      <header class="r-head">
        <span class="r-dot" data-ref="dot"></span>
        <h3 data-ref="name"></h3>
        <span class="r-ftp hint" data-ref="ftp"></span>
        <span class="r-state" data-ref="state"></span>
        <button class="icon-btn" data-act="remove" title="Remove from session" aria-label="Remove rider">✕</button>
      </header>

      <div class="r-phase">
        <div class="phase-bar" data-ref="bar"><i class="ph warm"></i><i class="ph eff"></i><i class="ph cool"></i><b class="marker" data-ref="marker"></b></div>
        <div class="stages" data-ref="stages">
          <div class="stage" data-stage="warmup"><span>Warm-up</span><b></b></div>
          <div class="stage" data-stage="effort"><span>Effort</span><b></b></div>
          <div class="stage" data-stage="cooldown"><span>Cool-down</span><b></b></div>
        </div>
      </div>

      <div class="r-result hidden" data-ref="result"></div>

      <div class="r-devices" data-ref="devices"></div>
      <div class="r-viz">
        <div class="r-chart"><canvas data-ref="chart"></canvas>
          <div class="legend"><span class="lg p">power (3 s)</span><span class="lg h">HR</span><span class="lg t">target</span></div>
        </div>
        <div class="r-gauges" data-ref="gauges"></div>
      </div>

      <div class="r-ctrl">
        <div class="ctrl-row">
          <span class="ctrl-label">Effort resistance</span>
          <div class="seg" role="group" aria-label="Resistance unit">
            <button data-act="mode" data-mode="percent">% of FTP</button>
            <button data-act="mode" data-mode="watts">Watts</button>
          </div>
          <div class="stepper">
            <button class="btn mini" data-act="nudge" data-dir="-1" aria-label="Decrease">−</button>
            <input type="number" data-ref="ctrlValue" min="1" step="1" aria-label="Resistance value" />
            <span class="unit" data-ref="ctrlUnit">%</span>
            <button class="btn mini" data-act="nudge" data-dir="1" aria-label="Increase">+</button>
          </div>
        </div>
        <div class="ctrl-row">
          <span class="ctrl-target" data-ref="target"></span>
          <span class="ctrl-actions">
            <button class="btn primary mini" data-act="start" data-ref="startBtn">Start</button>
            <button class="btn danger mini" data-act="stop" data-ref="stopBtn">Stop</button>
          </span>
        </div>
      </div>`;

    this.ref = {};
    this.el.querySelectorAll('[data-ref]').forEach((n) => (this.ref[n.dataset.ref] = n));
    this.powerGauge = new ZoneGauge(this.ref.gauges, { title: 'Power', unit: 'W' });
    this.hrGauge = new ZoneGauge(this.ref.gauges, { title: 'Heart rate', unit: 'bpm' });

    this.el.addEventListener('click', (e) => this.#onClick(e));
    this.el.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-act="devclick"]') && (e.preventDefault(), this.#onClick(e)));
    this.ref.ctrlValue.addEventListener('change', () => this.#commitValue());
    this.ref.ctrlValue.addEventListener('keydown', (e) => e.key === 'Enter' && this.ref.ctrlValue.blur());
    this.ref.name.textContent = p.name;
  }

  // --- structural state (from session snapshots) ----------------------------
  update(p, session) {
    this.p = p;
    this.session = session;
    this.ref.name.textContent = p.name;
    this.ref.ftp.textContent = p.ftp ? `FTP ${p.ftp} W` : 'no FTP set';
    this.#renderDevices();
    this.#renderControl();
    this.#renderZones();
    this.#renderState();
    if (!this.tick) this.#renderPhase(null);
    this.#renderResult();
  }

  // --- 1 Hz values -----------------------------------------------------------
  applyTick(r) {
    this.tick = r;
    this.#renderState();
    this.#renderPhase(r);
    this.#renderValues(r);
    this.#renderTarget();
    this.redraw();
  }

  redraw() {
    const s = getSettings();
    const target = this.tick?.control?.mode === 'erg' ? this.tick.control.targetWatts : null;
    drawHistory(this.ref.chart, this.ctx.history(this.userId), {
      windowSec: s.history.windowSeconds,
      powerZones: this.pz,
      target,
    });
  }

  // --- rendering helpers -----------------------------------------------------
  // Once this rider is done, their own result replaces the live view in the card,
  // so riders still testing never have to scroll to someone else's report.
  #renderResult() {
    const p = this.p;
    const done = p.state === 'finished' && p.result && this.session;
    this.el.classList.toggle('show-result', Boolean(done));
    this.ref.result.classList.toggle('hidden', !done);
    if (!done) {
      this.resultKey = '';
      return;
    }
    const key = `${this.session.id}|${p.result.estimatedFtp}|${p.result.sampleCount}`;
    if (key === this.resultKey) return;
    this.resultKey = key;
    this.ref.result.innerHTML = renderRiderResult({ id: this.session.id, test: this.session.test }, p);
  }

  #renderState() {
    const st = this.tick?.state ?? this.p.state;
    const t = this.session?.test;
    const total = t ? t.warmupSec + t.effortSec + t.cooldownSec : 0;
    let label = STATE_LABEL[st];
    if (st === 'scheduled' && this.tick) label = `Starts in ${fmtDuration(this.tick.startsIn)}`;
    else if (st === 'running' && this.tick) label = `${fmtDuration(this.tick.elapsed)} / ${fmtDuration(total)}`;
    else if (st === 'finished') label = `Finished · ${fmtDuration(total)}`;
    this.ref.state.textContent = label;
    this.ref.state.className = `r-state ${st}`;
    const finished = this.session?.state === 'finished';
    this.ref.startBtn.classList.toggle('hidden', st !== 'ready');
    this.ref.startBtn.disabled = finished;
    this.ref.stopBtn.classList.toggle('hidden', !(st === 'running' || st === 'scheduled'));
    this.el.classList.toggle('is-running', st === 'running');
  }

  #renderPhase(r) {
    const t = this.session?.test;
    if (!t) return;
    const total = t.warmupSec + t.effortSec + t.cooldownSec || 1;
    const [w, e, c] = this.ref.bar.querySelectorAll('.ph');
    w.style.flexGrow = t.warmupSec;
    e.style.flexGrow = t.effortSec;
    c.style.flexGrow = t.cooldownSec;
    const st = r?.state ?? this.p.state;
    const elapsed = st === 'finished' ? total : st === 'running' ? r?.elapsed ?? 0 : 0;
    this.ref.marker.style.left = `${Math.min(1, elapsed / total) * 100}%`;
    this.ref.marker.classList.toggle('hidden', st === 'ready' || st === 'scheduled');

    // Each stage: time spent / planned length, the active one highlighted.
    const stages = [['warmup', 0, t.warmupSec], ['effort', t.warmupSec, t.effortSec], ['cooldown', t.warmupSec + t.effortSec, t.cooldownSec]];
    for (const [name, start, len] of stages) {
      const el = this.ref.stages.querySelector(`[data-stage="${name}"]`);
      const cur = Math.min(len, Math.max(0, elapsed - start));
      el.querySelector('b').textContent = `${fmtDuration(cur)} / ${fmtDuration(len)}`;
      el.classList.toggle('active', st === 'running' && r?.phase === name);
      el.classList.toggle('done', len > 0 && cur >= len);
      el.classList.toggle('hidden', len === 0);
    }
  }

  // Two blocks: power (smart trainer / power meter) and heart rate. Each shows the
  // paired device and its live value; an empty block is the pairing button, and
  // clicking a paired device asks before disconnecting it.
  #renderDevices() {
    const devs = this.p.devices || [];
    const locked = this.p.state === 'finished';
    const dis = locked ? ' disabled' : '';
    const chip = (d) => {
      const local = this.ctx.isLocal(d.id);
      const retry = d.status === 'failed' && local ? `<button class="btn mini" data-act="retry" data-dev="${esc(d.id)}">Retry</button>` : '';
      const detail = d.detail ? ` · ${esc(d.detail)}` : '';
      const noCtl = (d.kind === 'trainer' || d.kind === 'sim') && d.status === 'connected' && !d.controllable ? ' <em class="warn-text">no resistance control</em>' : '';
      const hint = local ? 'Click to disconnect' : 'Paired on another screen';
      return `<div class="dev ${d.status} ${local && !locked ? 'clickable' : ''}" ${local && !locked ? `data-act="devclick" data-dev="${esc(d.id)}" role="button" tabindex="0"` : ''} title="${hint}">
        <span class="dev-ico">${DEVICE_ICON[d.kind]}</span>
        <div class="dev-main"><strong>${esc(d.name || KIND_LABEL[d.kind])}</strong>
          <small><span class="st-dot"></span>${STATUS_LABEL[d.status]}${detail}${noCtl}${local ? '' : ' · paired on another screen'}</small></div>
        <div class="dev-val" data-val="${d.kind}"><b>—</b></div>${retry}
      </div>`;
    };
    const empty = (icon, title, buttons) => `<div class="dev empty">
      <span class="dev-ico">${icon}</span>
      <div class="dev-main"><strong>${title}</strong><small>not connected</small></div>
      <div class="dev-pair">${buttons}</div></div>`;
    const pairBtn = (kind, label, cls = '') => `<button class="btn mini ${cls}" data-act="pair" data-kind="${kind}"${dis}>${label}</button>`;

    const power = devs.filter((d) => d.kind !== 'hr');
    const hr = devs.filter((d) => d.kind === 'hr');
    const hasTrainer = power.some((d) => d.kind === 'trainer' || d.kind === 'sim');
    const demo = this.ctx.demoEnabled ? pairBtn('sim', 'Demo', 'ghost') : '';
    const powerHtml = power.length
      ? power.map(chip).join('') + (hasTrainer ? '' : `<div class="dev-add">${pairBtn('trainer', '+ Smart trainer (resistance control)')}</div>`)
      : empty('🚴', 'Smart trainer / power meter', `${pairBtn('trainer', 'Pair smart trainer', 'primary')}${pairBtn('power', 'Pair power meter')}${demo}`);
    const hrHtml = hr.length ? hr.map(chip).join('') : empty('❤️', 'Heart-rate strap', pairBtn('hr', 'Pair HR strap', 'primary'));
    this.ref.devices.innerHTML = `<div class="dev-slot">${powerHtml}</div><div class="dev-slot">${hrHtml}</div>`;

    const connected = devs.filter((d) => d.status === 'connected').length;
    this.ref.dot.className = `r-dot ${devs.length && connected === devs.length ? 'ok' : connected ? 'part' : 'off'}`;
    this.ref.dot.title = devs.length ? `${connected} of ${devs.length} devices connected` : 'No devices paired';
    if (this.tick) this.#renderValues(this.tick);
  }

  #renderValues(r) {
    const power = r.power;
    const hr = r.hr;
    const pzone = zoneOf(this.pz, power);
    const hzone = zoneOf(this.hz, hr);
    const badge = (z) => (z ? `<i class="zb" style="background:${z.color}">Z${z.zone}</i>` : '');
    this.el.querySelectorAll('.dev-val').forEach((n) => {
      const kind = n.dataset.val;
      const connected = n.closest('.dev').classList.contains('connected');
      if (!connected) n.innerHTML = '<b>—</b>';
      else if (kind === 'hr') n.innerHTML = `<b>${hr ?? '—'}</b> bpm ${badge(hzone)}`;
      else n.innerHTML = `<b>${power ?? '—'}</b> W ${badge(pzone)}<span>${r.cadence ?? '—'} rpm</span>`;
    });
    this.powerGauge.update(power);
    this.hrGauge.update(hr);
  }

  // Gauges follow the rider's current FTP / LTHR; rebuilt only when those change.
  #renderZones() {
    const { ftp, lthr, maxHr } = this.p;
    const anchor = resolveLthr({ lthr, maxHr });
    const key = `${ftp}|${anchor.lthr}|${maxHr}`;
    if (key === this.zoneKey) return;
    this.zoneKey = key;
    this.pz = powerZones(ftp);
    this.hz = hrZones(anchor.lthr, maxHr);
    this.powerGauge.setZones(this.pz, 0, ftp ? Math.round(ftp * 1.6) : 1);
    const hrMax = maxHr || (anchor.lthr ? Math.round(anchor.lthr * 1.15) : 1);
    this.hrGauge.setZones(this.hz, anchor.lthr ? Math.round(anchor.lthr * 0.5) : 0, hrMax);
  }

  #renderControl() {
    const c = this.p.control;
    this.ref.ctrlUnit.textContent = c.mode === 'percent' ? '%' : 'W';
    this.el.querySelectorAll('[data-act="mode"]').forEach((b) => {
      b.classList.toggle('on', b.dataset.mode === c.mode);
      b.setAttribute('aria-pressed', b.dataset.mode === c.mode);
    });
    const input = this.ref.ctrlValue;
    if (document.activeElement !== input) input.value = c.mode === 'percent' ? c.percent : c.watts ?? this.#effortWatts() ?? '';
    this.#renderTarget();
  }

  #effortWatts() {
    const c = this.p.control;
    if (c.mode === 'watts') return c.watts;
    return this.p.ftp ? Math.round((this.p.ftp * c.percent) / 100) : null;
  }

  #renderTarget() {
    const c = this.p.control;
    const w = this.#effortWatts();
    const live = this.tick?.control;
    let text;
    if (c.mode === 'percent' && !this.p.ftp) text = '⚠ No FTP on file — set one in Athletes, or switch to Watts.';
    else if (w == null) text = 'Enter the watts to hold during the effort.';
    else text = `Effort target: ${w} W${c.mode === 'percent' ? ` (${c.percent}% of ${this.p.ftp} W)` : ''}`;
    if (live?.mode === 'erg') text += ' — trainer is holding it now';
    this.ref.target.textContent = text;
    this.ref.target.classList.toggle('warn-text', c.mode === 'percent' && !this.p.ftp);
  }

  // --- input ---------------------------------------------------------------
  #commitValue() {
    const v = Number(this.ref.ctrlValue.value);
    if (!Number.isFinite(v) || v <= 0) return this.#renderControl();
    const mode = this.p.control.mode;
    this.ctx.setControl(this.userId, mode === 'percent' ? { percent: v } : { watts: v });
  }

  #onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const c = this.p.control;
    switch (btn.dataset.act) {
      case 'pair':
        return this.ctx.pair(this.userId, btn.dataset.kind);
      case 'retry':
        return this.ctx.deviceAction(this.userId, btn.dataset.dev, 'retry');
      case 'devclick': {
        const dev = (this.p.devices || []).find((d) => d.id === btn.dataset.dev);
        return this.ctx.deviceAction(this.userId, btn.dataset.dev, dev?.status === 'failed' ? 'retry' : 'forget');
      }
      case 'remove':
        return this.ctx.remove(this.userId);
      case 'start':
        return this.ctx.startRider(this.userId);
      case 'stop':
        return this.ctx.stopRider(this.userId);
      case 'mode': {
        const mode = btn.dataset.mode;
        if (mode === c.mode) return;
        // Carry the current target over so switching units doesn't change the load.
        const w = this.#effortWatts();
        const patch = { mode };
        if (mode === 'watts' && w) patch.watts = w;
        if (mode === 'percent' && c.watts && this.p.ftp) patch.percent = Math.round((c.watts / this.p.ftp) * 100);
        return this.ctx.setControl(this.userId, patch);
      }
      case 'nudge': {
        const step = c.mode === 'percent' ? 1 : 5;
        const cur = Number(this.ref.ctrlValue.value) || (c.mode === 'percent' ? c.percent : this.#effortWatts() || 0);
        const next = Math.max(1, cur + Number(btn.dataset.dir) * step);
        this.ref.ctrlValue.value = next;
        return this.ctx.setControl(this.userId, c.mode === 'percent' ? { percent: next } : { watts: next });
      }
      default:
    }
  }
}
