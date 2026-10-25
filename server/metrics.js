// ---------------------------------------------------------------------------
// Sports-science calculations: FTP protocols, training zones, and workout
// summaries. Kept free of I/O so it can be unit-reasoned and reused.
// ---------------------------------------------------------------------------

// FTP-test protocols. `estimateFtp` maps the best sustained effort of the
// protocol's core interval to an FTP figure using the standard multipliers.
export const PROTOCOLS = {
  ftp20: {
    id: 'ftp20',
    name: '20-minute test',
    // ~5 min blowout, 20 min all-out effort. FTP = 95% of the 20-min average.
    coreSeconds: 20 * 60,
    multiplier: 0.95,
    description: 'All-out 20 minutes. FTP = 95% of average power.',
  },
  ftp8: {
    id: 'ftp8',
    name: '8-minute test',
    coreSeconds: 8 * 60,
    multiplier: 0.9,
    description: 'All-out 8 minutes. FTP = 90% of average power.',
  },
  ramp: {
    id: 'ramp',
    name: 'Ramp test',
    // FTP = 75% of best 1-minute power at exhaustion.
    coreSeconds: 60,
    multiplier: 0.75,
    description: 'Step up until failure. FTP = 75% of best 1-minute power.',
  },
};

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

// Heart-rate zones as a fraction of max HR.
export const HR_ZONES = [
  { zone: 1, name: 'Recovery', min: 0, max: 0.6, color: '#7ea6ff' },
  { zone: 2, name: 'Aerobic', min: 0.6, max: 0.7, color: '#4ec9b0' },
  { zone: 3, name: 'Tempo', min: 0.7, max: 0.8, color: '#c9d14e' },
  { zone: 4, name: 'Threshold', min: 0.8, max: 0.9, color: '#e6a23c' },
  { zone: 5, name: 'Maximal', min: 0.9, max: Infinity, color: '#f56c6c' },
];

export function powerZones(ftp) {
  if (!ftp) return [];
  return POWER_ZONES.map((z) => ({
    ...z,
    lowW: Math.round(z.min * ftp),
    highW: z.max === Infinity ? null : Math.round(z.max * ftp),
  }));
}

export function hrZones(maxHr) {
  if (!maxHr) return [];
  return HR_ZONES.map((z) => ({
    ...z,
    lowBpm: Math.round(z.min * maxHr),
    highBpm: z.max === Infinity ? null : Math.round(z.max * maxHr),
  }));
}

export function powerZoneFor(power, ftp) {
  if (!ftp || !power) return null;
  const frac = power / ftp;
  return POWER_ZONES.find((z) => frac >= z.min && frac < z.max) || POWER_ZONES.at(-1);
}

export function hrZoneFor(hr, maxHr) {
  if (!maxHr || !hr) return null;
  const frac = hr / maxHr;
  return HR_ZONES.find((z) => frac >= z.min && frac < z.max) || HR_ZONES.at(-1);
}

// Best average power over any window of `windowSeconds` within the samples.
// Samples carry `t` in ms and `power` in watts.
export function bestAveragePower(samples, windowSeconds) {
  const pts = samples.filter((s) => typeof s.power === 'number');
  if (pts.length === 0) return 0;
  const windowMs = windowSeconds * 1000;
  let best = 0;
  let start = 0;
  let sum = 0;
  // Sliding window over an irregular time series; average = area / duration.
  for (let end = 0; end < pts.length; end++) {
    while (end > start && pts[end].t - pts[start].t > windowMs) start++;
    const span = Math.max(1, pts[end].t - pts[start].t);
    let s = 0;
    for (let i = start; i <= end; i++) s += pts[i].power;
    const avg = s / (end - start + 1);
    if (pts[end].t - pts[start].t >= windowMs * 0.9) best = Math.max(best, avg);
  }
  // Fallback: if the effort was shorter than the window, use the whole set.
  if (best === 0) {
    sum = pts.reduce((a, s) => a + s.power, 0);
    best = sum / pts.length;
  }
  return Math.round(best);
}

// Normalized Power (Coggan): 4th-root of the mean of 30s-rolling-avg^4.
export function normalizedPower(samples) {
  const pts = samples.filter((s) => typeof s.power === 'number');
  if (pts.length < 2) return 0;
  const rolling = [];
  const windowMs = 30 * 1000;
  let start = 0;
  for (let end = 0; end < pts.length; end++) {
    while (pts[end].t - pts[start].t > windowMs) start++;
    let s = 0;
    for (let i = start; i <= end; i++) s += pts[i].power;
    rolling.push(s / (end - start + 1));
  }
  const mean4 = rolling.reduce((a, p) => a + p ** 4, 0) / rolling.length;
  return Math.round(mean4 ** 0.25);
}

// Build a full result summary for a participant at the end of a session.
export function summarize(samples, protocolId) {
  const protocol = PROTOCOLS[protocolId] || PROTOCOLS.ftp20;
  const powerPts = samples.filter((s) => typeof s.power === 'number');
  const hrPts = samples.filter((s) => typeof s.hr === 'number' && s.hr > 0);

  const avgPower = powerPts.length
    ? Math.round(powerPts.reduce((a, s) => a + s.power, 0) / powerPts.length)
    : 0;
  const maxPower = powerPts.length ? Math.max(...powerPts.map((s) => s.power)) : 0;
  const avgHr = hrPts.length ? Math.round(hrPts.reduce((a, s) => a + s.hr, 0) / hrPts.length) : 0;
  const maxHr = hrPts.length ? Math.max(...hrPts.map((s) => s.hr)) : 0;

  const coreAvg = bestAveragePower(samples, protocol.coreSeconds);
  const estimatedFtp = Math.round(coreAvg * protocol.multiplier);

  return {
    protocol: protocol.id,
    durationSec: powerPts.length ? Math.round((powerPts.at(-1).t - powerPts[0].t) / 1000) : 0,
    avgPower,
    maxPower,
    normalizedPower: normalizedPower(samples),
    avgHr,
    maxHr,
    bestCoreAvgPower: coreAvg,
    estimatedFtp,
    sampleCount: samples.length,
  };
}
