// Client-side zone maths (mirrors server/metrics.js) for live feedback.
export const POWER_ZONES = [
  { zone: 1, name: 'Active Recovery', min: 0, max: 0.55, color: '#7ea6ff' },
  { zone: 2, name: 'Endurance', min: 0.55, max: 0.75, color: '#4ec9b0' },
  { zone: 3, name: 'Tempo', min: 0.75, max: 0.9, color: '#c9d14e' },
  { zone: 4, name: 'Threshold', min: 0.9, max: 1.05, color: '#e6a23c' },
  { zone: 5, name: 'VO2 Max', min: 1.05, max: 1.2, color: '#f56c6c' },
  { zone: 6, name: 'Anaerobic', min: 1.2, max: 1.5, color: '#d6336c' },
  { zone: 7, name: 'Neuromuscular', min: 1.5, max: Infinity, color: '#9b1fbf' },
];

export const HR_ZONES = [
  { zone: 1, name: 'Recovery', min: 0, max: 0.6, color: '#7ea6ff' },
  { zone: 2, name: 'Aerobic', min: 0.6, max: 0.7, color: '#4ec9b0' },
  { zone: 3, name: 'Tempo', min: 0.7, max: 0.8, color: '#c9d14e' },
  { zone: 4, name: 'Threshold', min: 0.8, max: 0.9, color: '#e6a23c' },
  { zone: 5, name: 'Maximal', min: 0.9, max: Infinity, color: '#f56c6c' },
];

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

// Live coaching feedback comparing current power to a target band around FTP.
// During an FTP test the athlete should hold just below threshold and steady.
export function feedback(power, ftp) {
  if (!ftp || !power) return { text: 'Hold steady', tone: 'neutral' };
  const frac = power / ftp;
  if (frac > 1.15) return { text: 'Too hot — ease off', tone: 'high' };
  if (frac > 1.05) return { text: 'Above threshold', tone: 'high' };
  if (frac >= 0.95) return { text: 'On target', tone: 'good' };
  if (frac >= 0.85) return { text: 'Push a little more', tone: 'low' };
  return { text: 'Pick it up', tone: 'low' };
}

export function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
