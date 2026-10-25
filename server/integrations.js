// ---------------------------------------------------------------------------
// External platform integration (Strava / TrainingPeaks).
// ---------------------------------------------------------------------------
// Full OAuth + activity upload requires registered API credentials, which are
// environment-specific. This module implements the real OAuth URL construction
// and token exchange for Strava, and exposes a TCX exporter so a finished
// session can be pushed once credentials are configured. When credentials are
// absent the endpoints respond with a clear "not configured" status instead of
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

// Build a Garmin/Strava-compatible TCX document from logged samples so a
// session can be shared regardless of which platform is connected.
export function toTcx({ name, startedAt, samples }) {
  const start = new Date(startedAt || Date.now()).toISOString();
  const trackpoints = samples
    .filter((s) => typeof s.power === 'number')
    .map((s) => {
      const time = new Date((startedAt || Date.now()) + s.t).toISOString();
      return `        <Trackpoint>
          <Time>${time}</Time>
          ${s.hr ? `<HeartRateBpm><Value>${Math.round(s.hr)}</Value></HeartRateBpm>` : ''}
          ${s.cadence ? `<Cadence>${Math.round(s.cadence)}</Cadence>` : ''}
          <Extensions><ns3:TPX><ns3:Watts>${Math.round(s.power)}</ns3:Watts></ns3:TPX></Extensions>
        </Trackpoint>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>${start}</Id>
      <Lap StartTime="${start}">
        <Track>
${trackpoints}
        </Track>
      </Lap>
      <Notes>${escapeXml(name || 'FTP Test')}</Notes>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}
