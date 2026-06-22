export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  res.status(200).json({
    status: 'ok', version: '5.0.0',
    timestamp: new Date().toISOString(),
    services: { gemini: !!process.env.GEMINI_API_KEY, football: !!process.env.APIFOOTBALL_KEY },
    method: {
      football: 'Poisson (probabilités calculées)',
      hippique: 'Score-musique (probabilités calculées)',
      role_ia: 'Commentaire uniquement (pas de calcul de probabilités)',
    },
    features: {
      cache: true, retry: true, demo_mode: true,
      poisson_model: true, musique_scoring: true,
      cross_check_odds: true, confidence_intervals: true,
      backtesting: true, team_autocomplete: !!process.env.APIFOOTBALL_KEY, pmu_race_selector: true,
    },
    endpoints: ['/api/football', '/api/hippique', '/api/teams', '/api/races', '/api/backtest', '/api/health'],
  });
}
