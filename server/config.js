// Central configuration. Reads from environment with sensible local defaults.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const PUBLIC_DIR = path.join(ROOT, 'public');

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
