// Central configuration. Reads from environment with sensible local defaults.
// Tunable test/smoothing parameters live in config/settings.json (see README).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const SETTINGS_FILE = path.join(ROOT, 'config', 'settings.json');

// Built-in defaults; config/settings.json overrides them key by key.
const DEFAULT_SETTINGS = {
  smoothing: { windowSeconds: 3, staleAfterSeconds: 5 },
  history: { windowSeconds: 300 },
  test: {
    warmupMinutes: 10,
    effortMinutes: 20,
    cooldownMinutes: 5,
    effortPercentFtp: 90,
    minEffortMinutes: 8,
    maxEffortMinutes: 60,
    staggerSeconds: 30,
    minCompletionForProfileUpdate: 0.9,
  },
  ftpFactors: [[8, 0.9], [10, 0.92], [12, 0.93], [15, 0.94], [20, 0.95], [30, 0.97], [45, 0.99], [60, 1]],
  heartRate: { lthrFractionOfMax: 0.9, zoneBoundsPctLthr: [0.68, 0.83, 0.94, 1.05, 1.1, 1.15] },
};

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

function loadSettings() {
  try {
    return merge(DEFAULT_SETTINGS, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Ignoring invalid ${SETTINGS_FILE}: ${err.message}`);
    return DEFAULT_SETTINGS;
  }
}

export const settings = loadSettings();

export const config = {
  port: Number(process.env.PORT) || 3000,
  strava: {
    clientId: process.env.STRAVA_CLIENT_ID || '',
    clientSecret: process.env.STRAVA_CLIENT_SECRET || '',
    redirectUri: process.env.STRAVA_REDIRECT_URI || 'http://localhost:3000/api/integrations/strava/callback',
  },
  trainingPeaks: {
    clientId: process.env.TRAININGPEAKS_CLIENT_ID || '',
    clientSecret: process.env.TRAININGPEAKS_CLIENT_SECRET || '',
    redirectUri: process.env.TRAININGPEAKS_REDIRECT_URI || 'http://localhost:3000/api/integrations/trainingpeaks/callback',
  },
};
