// ---------------------------------------------------------------------------
// Visuals: zone gauges (SVG) and the per-rider 5-minute history chart (canvas).
// ---------------------------------------------------------------------------
import { zoneOf } from './metrics.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, parent) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  parent?.appendChild(el);
  return el;
};

const CX = 100;
const CY = 100;
const R_OUT = 88;
const R_IN = 66;

function pt(frac, r) {
  const a = Math.PI * (1 - frac);
  return [CX + r * Math.cos(a), CY - r * Math.sin(a)];
}

function segmentPath(f0, f1) {
  const [x0, y0] = pt(f0, R_OUT);
  const [x1, y1] = pt(f1, R_OUT);
  const [x2, y2] = pt(f1, R_IN);
  const [x3, y3] = pt(f0, R_IN);
  return `M${x0} ${y0} A${R_OUT} ${R_OUT} 0 0 1 ${x1} ${y1} L${x2} ${y2} A${R_IN} ${R_IN} 0 0 0 ${x3} ${y3}Z`;
}

// Half-circle gauge whose arc is split into the athlete's training zones. The
// needle shows the (smoothed) value; the zone it sits in is highlighted.
export class ZoneGauge {
  constructor(container, { title, unit }) {
    this.unit = unit;
    this.zones = [];
    this.min = 0;
    this.max = 1;
    this.root = svg('svg', { viewBox: '0 0 200 142', class: 'gauge', role: 'img', 'aria-label': `${title} zone gauge` });
    this.segs = svg('g', {}, this.root);
    this.needle = svg('g', { class: 'needle' }, this.root);
    svg('line', { x1: CX, y1: CY, x2: CX - (R_IN - 4), y2: CY, stroke: '#263241', 'stroke-width': 3, 'stroke-linecap': 'round' }, this.needle);
    svg('circle', { cx: CX, cy: CY, r: 5, fill: '#263241' }, this.root);
    this.valueEl = svg('text', { x: CX, y: 128, class: 'g-value' }, this.root);
    this.zoneEl = svg('text', { x: CX, y: 140, class: 'g-zone' }, this.root);
    this.minEl = svg('text', { x: 14, y: 114, class: 'g-end' }, this.root);
    this.maxEl = svg('text', { x: 186, y: 114, class: 'g-end', 'text-anchor': 'end' }, this.root);
    svg('text', { x: CX, y: 18, class: 'g-title' }, this.root).textContent = title;
    container.appendChild(this.root);
    this.setZones([], 0, 1);
  }

  // zones: [{zone,name,color,lo,hi}] — hi null = open ended. [min,max] = gauge scale.
  setZones(zones, min, max) {
    this.zones = zones;
    this.min = min;
    this.max = max;
    this.segs.replaceChildren();
    this.segEls = [];
    const span = Math.max(1, max - min);
    if (!zones.length) {
      svg('path', { d: segmentPath(0, 1), fill: '#e3e9f0' }, this.segs);
    }
    for (const z of zones) {
      const lo = Math.max(min, z.lo);
      const hi = Math.min(max, z.hi ?? max);
      if (hi - lo <= 0.5) continue;
      const el = svg('path', { d: segmentPath((lo - min) / span, (hi - min) / span), fill: z.color, 'fill-opacity': 0.4, stroke: '#fff', 'stroke-width': 1.5 }, this.segs);
      this.segEls.push({ z, el });
    }
    this.minEl.textContent = zones.length ? Math.round(min) : '';
    this.maxEl.textContent = zones.length ? Math.round(max) : '';
    this.update(null);
  }

  update(value) {
    const has = value !== null && value !== undefined && this.zones.length;
    const frac = has ? Math.min(1, Math.max(0, (value - this.min) / Math.max(1, this.max - this.min))) : 0;
    this.needle.setAttribute('transform', `rotate(${frac * 180} ${CX} ${CY})`);
    const zone = has ? zoneOf(this.zones, value) : null;
    for (const { z, el } of this.segEls) el.setAttribute('fill-opacity', z === zone ? 1 : 0.4);
    this.valueEl.textContent = has ? `${Math.round(value)} ${this.unit}` : this.zones.length ? '—' : 'no zones';
    this.zoneEl.textContent = zone ? `Z${zone.zone} ${zone.name}` : this.zones.length ? '' : 'set FTP / HR in Athletes';
    this.zoneEl.setAttribute('fill', zone ? '#263241' : '#6b7684');
  }
}

// 5-minute history of smoothed power (left axis) and heart rate (right axis),
// with the power zones as faint bands and the ERG target as a dashed line.
export function drawHistory(canvas, history, { windowSec, powerZones = [], target = null, now = Date.now() }) {
  const dpr = window.devicePixelRatio || 1;
  const w = (canvas.width = Math.max(1, canvas.clientWidth) * dpr);
  const h = (canvas.height = Math.max(1, canvas.clientHeight) * dpr);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const padL = 34 * dpr;
  const padR = 34 * dpr;
  const padT = 8 * dpr;
  const padB = 18 * dpr;
  const x0 = now - windowSec * 1000;
  const pw = w - padL - padR;
  const ph = h - padT - padB;

  const maxP = Math.max(150, target || 0, ...history.map((p) => p[1] || 0), (powerZones[4]?.lo ?? 0) * 1.0);
  const hrs = history.map((p) => p[2]).filter(Boolean);
  const minH = hrs.length ? Math.floor((Math.min(...hrs) - 10) / 10) * 10 : 60;
  const maxH = hrs.length ? Math.ceil((Math.max(...hrs) + 5) / 10) * 10 : 180;
  const X = (ts) => padL + ((ts - x0) / (windowSec * 1000)) * pw;
  const YP = (v) => padT + ph - (v / maxP) * ph;
  const YH = (v) => padT + ph - ((v - minH) / Math.max(10, maxH - minH)) * ph;

  // zone bands
  for (const z of powerZones) {
    const lo = Math.min(maxP, z.lo);
    const hi = Math.min(maxP, z.hi ?? maxP);
    if (hi <= lo) continue;
    ctx.fillStyle = hexA(z.color, 0.1);
    ctx.fillRect(padL, YP(hi), pw, YP(lo) - YP(hi));
  }

  // grid + labels
  ctx.font = `${10 * dpr}px Roboto, sans-serif`;
  ctx.strokeStyle = 'rgba(38,50,65,0.1)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#6b7684';
  for (let g = 0; g <= 4; g++) {
    const y = padT + (ph * g) / 4;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(maxP * (1 - g / 4)), padL - 4 * dpr, y + 3 * dpr);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#c43';
    ctx.fillText(Math.round(maxH - ((maxH - minH) * g) / 4), w - padR + 4 * dpr, y + 3 * dpr);
    ctx.fillStyle = '#6b7684';
  }
  ctx.textAlign = 'center';
  for (let m = 0; m <= windowSec / 60; m++) {
    const x = X(now - m * 60000);
    ctx.fillText(m === 0 ? 'now' : `-${m}m`, Math.max(padL + 8 * dpr, Math.min(w - padR, x)), h - 4 * dpr);
  }

  if (target) {
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.strokeStyle = '#263241';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(padL, YP(target));
    ctx.lineTo(w - padR, YP(target));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const line = (idx, Y, color, lw) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = lw * dpr;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    for (const p of history) {
      const v = p[idx];
      if (v === null || v === undefined || p[0] < x0) {
        pen = false;
        continue;
      }
      pen ? ctx.lineTo(X(p[0]), Y(v)) : ctx.moveTo(X(p[0]), Y(v));
      pen = true;
    }
    ctx.stroke();
  };
  line(2, YH, '#e02020', 1.5);
  line(1, YP, '#1d8fc4', 2.2);
}

export function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
