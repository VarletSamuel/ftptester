import { Router } from 'express';
import {
  stravaConfigured,
  trainingPeaksConfigured,
  stravaAuthUrl,
  stravaExchangeToken,
  trainingPeaksAuthUrl,
} from '../integrations.js';

export const integrationsRouter = Router();

// Report which platforms are ready to use (credentials present).
integrationsRouter.get('/status', (req, res) => {
  res.json({
    strava: { configured: stravaConfigured() },
    trainingpeaks: { configured: trainingPeaksConfigured() },
  });
});

integrationsRouter.get('/strava/connect', (req, res) => {
  if (!stravaConfigured()) {
    return res.status(503).json({ error: 'Strava not configured. Set STRAVA_CLIENT_ID/SECRET.' });
  }
  res.redirect(stravaAuthUrl(String(req.query.state || '')));
});

integrationsRouter.get('/strava/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`Strava authorization failed: ${error}`);
  if (!code) return res.status(400).send('Missing authorization code');
  try {
    const token = await stravaExchangeToken(String(code));
    // A production app would persist the token against the signed-in user.
    res.send(
      `<h2>Strava connected</h2><p>Athlete: ${token.athlete?.firstname || ''} ${token.athlete?.lastname || ''}</p><p>You can close this window.</p>`,
    );
  } catch (err) {
    res.status(502).send(`Token exchange failed: ${err.message}`);
  }
});

integrationsRouter.get('/trainingpeaks/connect', (req, res) => {
  if (!trainingPeaksConfigured()) {
    return res.status(503).json({ error: 'TrainingPeaks not configured. Set TRAININGPEAKS_CLIENT_ID/SECRET.' });
  }
  res.redirect(trainingPeaksAuthUrl(String(req.query.state || '')));
});
