// Client-side zone maths (mirrors server/metrics.js). The tunable parts (HR zone
// bounds, LTHR fallback, FTP factors) come from the backend's config/settings.json.
export const POWER_ZONES = [
  { zone: 1, name: 'Active Recovery', min: 0, max: 0.55, color: '#7ea6ff' },
  { zone: 2, name: 'Endurance', min: 0.55, max: 0.75, color: '#4ec9b0' },
  { zone: 3, name: 'Tempo', min: 0.75, max: 0.9, color: '#c9d14e' },
  { zone: 4, name: 'Threshold', min: 0.9, max: 1.05, color: '#e6a23c' },
  { zone: 5, name: 'VO2 Max', min: 1.05, max: 1.2, color: '#f56c6c' },
  { zone: 6, name: 'Anaerobic', min: 1.2, max: 1.5, color: '#d6336c' },
  { zone: 7, name: 'Neuromuscular', min: 1.5, max: Infinity, color: '#9b1fbf' },
];

let settings = {
  heartRate: { lthrFractionOfMax: 0.9, zoneBoundsPctLthr: [0.68, 0.83, 0.94, 1.05, 1.1, 1.15] },
  ftpFactors: [[8, 0.9], [20, 0.95], [60, 1]],
  history: { windowSeconds: 300 },
  test: {},
};

export const configure = (s) => (settings = s);
export const getSettings = () => settings;

export function ftpFactor(minutes) {
  const t = [...settings.ftpFactors].sort((a, b) => a[0] - b[0]);
  if (minutes <= t[0][0]) return t[0][1];
  if (minutes >= t.at(-1)[0]) return t.at(-1)[1];
  for (let i = 1; i < t.length; i++) {
    if (minutes <= t[i][0]) return t[i - 1][1] + ((t[i][1] - t[i - 1][1]) * (minutes - t[i - 1][0])) / (t[i][0] - t[i - 1][0]);
  }
  return 1;
}

export function resolveLthr({ lthr, maxHr }) {
  if (lthr) return { lthr: Math.round(lthr), estimated: false };
  if (maxHr) return { lthr: Math.round(maxHr * settings.heartRate.lthrFractionOfMax), estimated: true };
  return { lthr: null, estimated: false };
}

// 7 power zones with watt ranges.
export function powerZones(ftp) {
  if (!ftp) return [];
  return POWER_ZONES.map((z) => ({
    ...z,
    lo: Math.round(z.min * ftp),
    hi: z.max === Infinity ? null : Math.round(z.max * ftp),
  }));
}

// 7 heart-rate zones matching the power zones, anchored on LTHR and capped at max HR.
export function hrZones(lthr, maxHr) {
  if (!lthr) return [];
  const b = settings.heartRate.zoneBoundsPctLthr;
  const cap = (v) => (maxHr ? Math.min(v, maxHr) : v);
  return POWER_ZONES.map((z, i) => {
    const min = i === 0 ? 0 : b[i - 1];
    const max = i === POWER_ZONES.length - 1 ? Infinity : b[i];
    return {
      zone: z.zone,
      name: z.name,
      color: z.color,
      min,
      max,
      lo: cap(Math.round(min * lthr)),
      hi: max === Infinity ? maxHr || null : cap(Math.round(max * lthr)),
    };
  });
}

export function zoneOf(zones, value) {
  if (!value || !zones.length) return null;
  return zones.find((z) => value >= z.lo && (z.hi === null || value < z.hi)) || zones.at(-1);
}

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, '0')}`;
}
