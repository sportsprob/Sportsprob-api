import { cacheGet, cacheSet, withRetry, fetchWithTimeout } from './_lib.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const q = (req.query?.q || '').trim();
  if (q.length < 3) { res.status(200).json({ teams: [] }); return; }
  if (!process.env.APIFOOTBALL_KEY) { res.status(200).json({ teams: [], error: 'no_key' }); return; }

  const cacheKey = `search:${q.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) { res.status(200).json({ teams: cached, cached: true }); return; }

  try {
    const url = new URL('https://v3.football.api-sports.io/teams');
    url.searchParams.set('search', q);
    const data = await withRetry(async () => {
      const r = await fetchWithTimeout(url.toString(), {
        headers: { 'x-apisports-key': process.env.APIFOOTBALL_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' },
      }, 8000);
      if (r.status === 429) throw new Error('quota');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }, { retries: 1, delayMs: 500 });

    const teams = (data.response || []).slice(0, 8).map(t => ({
      name: t.team.name,
      country: t.team.country,
      logo: t.team.logo,
    }));
    cacheSet(cacheKey, teams);
    res.status(200).json({ teams });
  } catch (err) {
    // En cas d'erreur (quota...), on renvoie une liste vide sans bloquer la saisie
    res.status(200).json({ teams: [], error: err.message });
  }
}
