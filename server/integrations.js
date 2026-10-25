// ---------------------------------------------------------------------------
// External platform integration (Strava / TrainingPeaks).
// ---------------------------------------------------------------------------
// Full OAuth + activity upload requires registered API credentials, which are
// environment-specific. This module implements the real OAuth URL construction
// and token exchange for Strava (TCX/GPX/Excel exports live in export.js).
// When credentials are absent the endpoints respond with a clear "not configured" status instead of
// failing, so the app stays runnable out of the box.
// ---------------------------------------------------------------------------

import { config } from './config.js';

export function stravaConfigured() {
  return Boolean(config.strava.clientId && config.strava.clientSecret);
}

export function trainingPeaksConfigured() {
  return Boolean(config.trainingPeaks.clientId && config.trainingPeaks.clientSecret);
}

export function stravaAuthUrl(state = '') {
  const params = new URLSearchParams({
    client_id: config.strava.clientId,
    redirect_uri: config.strava.redirectUri,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'activity:write,read',
    state,
  });
  return `https://www.strava.com/oauth/authorize?${params}`;
}

export async function stravaExchangeToken(code) {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.strava.clientId,
      client_secret: config.strava.clientSecret,
      code,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Strava token exchange failed: ${res.status}`);
  return res.json();
}

export function trainingPeaksAuthUrl(state = '') {
  const params = new URLSearchParams({
    client_id: config.trainingPeaks.clientId,
    redirect_uri: config.trainingPeaks.redirectUri,
    response_type: 'code',
    scope: 'workouts:write',
    state,
  });
  // Sandbox host; production partners receive their own base URL.
  return `https://oauth.sandbox.trainingpeaks.com/OAuth/Authorize?${params}`;
}
