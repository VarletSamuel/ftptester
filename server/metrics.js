// ---------------------------------------------------------------------------
// Sports-science calculations: FTP adjustment factors, training zones and test
// summaries. Kept free of I/O so it can be unit-reasoned and reused.
// ---------------------------------------------------------------------------

import { settings } from './config.js';

// Coggan power zones as a fraction of FTP.
export const POWER_ZONES = [
  { zone: 1, name: 'Active Recovery', min: 0, max: 0.55, color: '#7ea6ff' },
  { zone: 2, name: 'Endurance', min: 0.55, max: 0.75, color: '#4ec9b0' },
  { zone: 3, name: 'Tempo', min: 0.75, max: 0.9, color: '#c9d14e' },
  { zone: 4, name: 'Threshold', min: 0.9, max: 1.05, color: '#e6a23c' },
  { zone: 5, name: 'VO2 Max', min: 1.05, max: 1.2, color: '#f56c6c' },
  { zone: 6, name: 'Anaerobic', min: 1.2, max: 1.5, color: '#d6336c' },
  { zone: 7, name: 'Neuromuscular', min: 1.5, max: Infinity, color: '#9b1fbf' },
];

// Heart-rate zones "matching" the 7 power zones, as a fraction of LTHR. The
// bounds come from config/settings.json (heartRate.zoneBoundsPctLthr).
export function hrZoneDefs() {
  const bounds = settings.heartRate.zoneBoundsPctLthr;
  return POWER_ZONES.map((z, i) => ({
    zone: z.zone,
    name: z.name,
    color: z.color,
    min: i === 0 ? 0 : bounds[i - 1],
    max: i === POWER_ZONES.length - 1 ? Infinity : bounds[i],
  }));
}

// --- FTP adjustment factor for shortened tests -----------------------------
// Linear interpolation over the configured [minutes, factor] table, clamped to
// its ends. 20 min -> 0.95 and 8 min -> 0.90 are the established protocols.
export function ftpFactor(minutes) {
  const table = [...settings.ftpFactors].sort((a, b) => a[0] - b[0]);
  if (minutes <= table[0][0]) return table[0][1];
  if (minutes >= table.at(-1)[0]) return table.at(-1)[1];
  for (let i = 1; i < table.length; i++) {
    const [m1, f1] = table[i];
    const [m0, f0] = table[i - 1];
    if (minutes <= m1) return f0 + ((f1 - f0) * (minutes - m0)) / (m1 - m0);
  }
  return 1;
}

// Normalise a session's test configuration (minutes in, seconds + factor out).
export function buildTestConfig(input = {}) {
  const d = settings.test;
  const clamp = (v, lo, hi, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  const warmupMinutes = clamp(input.warmupMinutes, 0, 60, d.warmupMinutes);
  const effortMinutes = clamp(input.effortMinutes, d.minEffortMinutes, d.maxEffortMinutes, d.effortMinutes);
  const cooldownMinutes = clamp(input.cooldownMinutes, 0, 60, d.cooldownMinutes);
  return {
    warmupMinutes,
    effortMinutes,
    cooldownMinutes,
    effortPercentFtp: clamp(input.effortPercentFtp, 30, 150, d.effortPercentFtp),
    staggerSeconds: clamp(input.staggerSeconds, 0, 600, d.staggerSeconds),
    warmupSec: Math.round(warmupMinutes * 60),
    effortSec: Math.round(effortMinutes * 60),
    cooldownSec: Math.round(cooldownMinutes * 60),
    ftpFactor: Number(ftpFactor(effortMinutes).toFixed(4)),
  };
}

// Phase for a rider `elapsedSec` after their own start.
export function phaseAt(test, elapsedSec) {
  if (elapsedSec < test.warmupSec) return { phase: 'warmup', remaining: test.warmupSec - elapsedSec };
  const e = elapsedSec - test.warmupSec;
  if (e < test.effortSec) return { phase: 'effort', remaining: test.effortSec - e };
  const c = e - test.effortSec;
  if (c < test.cooldownSec) return { phase: 'cooldown', remaining: test.cooldownSec - c };
  return { phase: 'done', remaining: 0 };
}

// --- zones ------------------------------------------------------------------
export function powerZones(ftp) {
  if (!ftp) return [];
  return POWER_ZONES.map((z) => ({
    ...z,
    lowW: Math.round(z.min * ftp),
    highW: z.max === Infinity ? null : Math.round(z.max * ftp),
  }));
}

// Resolve the heart-rate anchor: measured LTHR if known, otherwise estimated
// from max HR using heartRate.lthrFractionOfMax.
export function resolveLthr({ lthr, maxHr } = {}) {
  if (lthr) return { lthr: Math.round(lthr), estimated: false };
  if (maxHr) return { lthr: Math.round(maxHr * settings.heartRate.lthrFractionOfMax), estimated: true };
  return { lthr: null, estimated: false };
}

export function hrZones(lthr, maxHr = null) {
  if (!lthr) return [];
  const cap = (v) => (maxHr ? Math.min(v, maxHr) : v);
  return hrZoneDefs().map((z) => ({
    ...z,
    lowBpm: cap(Math.round(z.min * lthr)),
    highBpm: z.max === Infinity ? (maxHr ?? null) : cap(Math.round(z.max * lthr)),
  }));
}

function zoneIndex(zones, frac) {
  const i = zones.findIndex((z) => frac >= z.min && frac < z.max);
  return i === -1 ? zones.length - 1 : i;
}

// --- summary ----------------------------------------------------------------
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// Normalized Power (Coggan): 4th-root of the mean of 30s-rolling-avg^4.
export function normalizedPower(powers) {
  if (powers.length < 30) return Math.round(avg(powers));
  let sum = 0;
  let mean4 = 0;
  let n = 0;
  for (let i = 0; i < powers.length; i++) {
    sum += powers[i];
    if (i >= 30) sum -= powers[i - 30];
    if (i >= 29) {
      mean4 += (sum / 30) ** 4;
      n++;
    }
  }
  return Math.round((mean4 / n) ** 0.25);
}

// Build the per-rider test result. Samples are ~1 Hz, `t` in ms since the
// rider's own start, so the effort window can be cut out exactly.
export function summarize(samples, test, rider = {}) {
  const effortStart = test.warmupSec * 1000;
  const effortEnd = effortStart + test.effortSec * 1000;
  const effort = samples.filter((s) => s.t >= effortStart && s.t < effortEnd);
  const effortPower = effort.filter((s) => s.power != null).map((s) => s.power);
  const effortHr = effort.filter((s) => s.hr > 0).map((s) => s.hr);
  const allHr = samples.filter((s) => s.hr > 0).map((s) => s.hr);

  const effortCompletion = test.effortSec ? Math.min(1, effort.length / test.effortSec) : 0;
  const avgPower = Math.round(avg(effortPower));
  const factor = test.ftpFactor;
  const estimatedFtp = Math.round(avgPower * factor);

  // LTHR ≈ average HR of the final part of the all-out effort (last 15 min, or
  // the whole effort when it is shorter).
  const tail = effort.slice(-15 * 60).filter((s) => s.hr > 0).map((s) => s.hr);
  const measuredLthr = effortCompletion >= settings.test.minCompletionForProfileUpdate && tail.length >= 60
    ? Math.round(avg(tail))
    : null;
  const maxHr = allHr.length ? Math.max(...allHr) : 0;
  const hrAnchor = resolveLthr({ lthr: measuredLthr || rider.lthr, maxHr: Math.max(maxHr, rider.maxHr || 0) || null });

  const pz = powerZones(estimatedFtp);
  const hz = hrZones(hrAnchor.lthr, rider.maxHr || null);
  const powerSecs = new Array(POWER_ZONES.length).fill(0);
  const hrSecs = new Array(POWER_ZONES.length).fill(0);
  let powerN = 0;
  let hrN = 0;
  for (const s of samples) {
    if (estimatedFtp && s.power != null) {
      powerSecs[zoneIndex(POWER_ZONES, s.power / estimatedFtp)]++;
      powerN++;
    }
    if (hz.length && s.hr > 0) {
      hrSecs[zoneIndex(hz, s.hr / hrAnchor.lthr)]++;
      hrN++;
    }
  }

  const zones = POWER_ZONES.map((z, i) => ({
    zone: z.zone,
    name: z.name,
    color: z.color,
    pctMin: z.min,
    pctMax: z.max === Infinity ? null : z.max,
    lowW: pz[i]?.lowW ?? null,
    highW: pz[i]?.highW ?? null,
    lowBpm: hz[i]?.lowBpm ?? null,
    highBpm: hz[i]?.highBpm ?? null,
    powerSeconds: powerSecs[i],
    powerPct: powerN ? powerSecs[i] / powerN : 0,
    hrSeconds: hrSecs[i],
    hrPct: hrN ? hrSecs[i] / hrN : 0,
  }));

  return {
    effortMinutes: test.effortMinutes,
    adjustmentFactor: factor,
    effortCompletion: Number(effortCompletion.toFixed(3)),
    durationSec: samples.length ? Math.round(samples.at(-1).t / 1000) : 0,
    ftpBefore: rider.ftp ?? null,
    avgPower,
    maxPower: effortPower.length ? Math.max(...effortPower) : 0,
    normalizedPower: normalizedPower(effortPower),
    avgHr: Math.round(avg(effortHr)),
    maxHr,
    lthr: hrAnchor.lthr,
    lthrEstimated: hrAnchor.estimated,
    measuredLthr,
    estimatedFtp,
    wattsPerKg: rider.weightKg && estimatedFtp ? Number((estimatedFtp / rider.weightKg).toFixed(2)) : null,
    zones,
    sampleCount: samples.length,
  };
}
