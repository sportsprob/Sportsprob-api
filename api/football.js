import {
  cacheGet, cacheSet, cacheAge, withRetry, fetchWithTimeout, callGemini,
} from './_lib.js';
import {
  poissonAnalysis, crossCheck, confidenceInterval, confidenceLevel, footballReliability,
} from './_models.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function apif(endpoint, params = {}) {
  const url = new URL(`https://v3.football.api-sports.io/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return withRetry(async () => {
    const res = await fetchWithTimeout(url.toString(), {
      headers: { 'x-apisports-key': process.env.APIFOOTBALL_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' },
    }, 12000);
    if (res.status === 429) throw new Error('Quota API-Football épuisé (100/jour). Réessayez demain.');
    if (!res.ok) throw new Error(`API-Football ${endpoint}: HTTP ${res.status}`);
    const data = await res.json();
    if (data.errors && Object.keys(data.errors).length > 0) {
      const msg = Object.values(data.errors)[0];
      if (/requests?.*limit|rate/i.test(String(msg))) throw new Error('Quota API-Football atteint pour aujourd\'hui.');
      throw new Error(`API-Football: ${msg}`);
    }
    return data.response || [];
  }, { retries: 2, delayMs: 700, label: endpoint });
}

async function findTeamId(name) {
  const ck = `team:${name.toLowerCase().trim()}`;
  const c = cacheGet(ck); if (c) return c;
  const results = await apif('teams', { search: name.trim() });
  if (!results.length) throw new Error(`Équipe introuvable : "${name}". Essayez le nom complet (ex: "Paris Saint-Germain").`);
  const team = { id: results[0].team.id, name: results[0].team.name };
  cacheSet(ck, team); return team;
}

async function getRecentFixtures(teamId, n = 8) {
  const results = await apif('fixtures', { team: teamId, last: n, status: 'FT-AET-PEN' });
  return results.map(f => {
    const homeWin = f.teams.home.winner === true, awayWin = f.teams.away.winner === true;
    const isHome = f.teams.home.id === teamId;
    const won = (isHome && homeWin) || (!isHome && awayWin);
    const lost = (isHome && awayWin) || (!isHome && homeWin);
    return {
      date: f.fixture.date?.slice(0,10), home: f.teams.home.name, away: f.teams.away.name,
      score: `${f.goals.home ?? '?'}-${f.goals.away ?? '?'}`, result: won ? 'V' : lost ? 'D' : 'N',
      goalsFor: isHome ? (f.goals.home ?? 0) : (f.goals.away ?? 0),
      goalsAgainst: isHome ? (f.goals.away ?? 0) : (f.goals.home ?? 0),
      isHome, leagueId: f.league?.id, season: f.league?.season,
    };
  });
}

async function getH2H(t1, t2) {
  const results = await apif('fixtures/headtohead', { h2h: `${t1}-${t2}`, last: 10, status: 'FT-AET-PEN' });
  const h2h = { team1Wins: 0, team2Wins: 0, draws: 0, recentMatches: [] };
  results.forEach(f => {
    const hw = f.teams.home.winner === true, aw = f.teams.away.winner === true;
    if (!hw && !aw) h2h.draws++;
    else if ((f.teams.home.id === t1 && hw) || (f.teams.away.id === t1 && aw)) h2h.team1Wins++;
    else h2h.team2Wins++;
    h2h.recentMatches.push({ date: f.fixture.date?.slice(0,10), home: f.teams.home.name, away: f.teams.away.name, score: `${f.goals.home}-${f.goals.away}` });
  });
  return h2h;
}

async function getTeamStats(teamId, leagueId, season) {
  try {
    const r = await apif('teams/statistics', { team: teamId, league: leagueId, season });
    if (!r || !r.form) return null;
    return {
      played: r.fixtures?.played?.total || 0,
      goalsForAvg: parseFloat(r.goals?.for?.average?.total || '0') || 0,
      goalsAgainstAvg: parseFloat(r.goals?.against?.average?.total || '0') || 0,
      goalsForHome: parseFloat(r.goals?.for?.average?.home || '0') || 0,
      goalsAgainstHome: parseFloat(r.goals?.against?.average?.home || '0') || 0,
      goalsForAway: parseFloat(r.goals?.for?.average?.away || '0') || 0,
      goalsAgainstAway: parseFloat(r.goals?.against?.average?.away || '0') || 0,
      form: r.form,
    };
  } catch { return null; }
}

// Calcule les moyennes de buts depuis les fixtures récentes (fallback si pas de stats API)
function avgFromFixtures(fixtures) {
  if (!fixtures.length) return { gf: 1.4, ga: 1.4 };
  const gf = fixtures.reduce((s, f) => s + f.goalsFor, 0) / fixtures.length;
  const ga = fixtures.reduce((s, f) => s + f.goalsAgainst, 0) / fixtures.length;
  return { gf, ga };
}

// Gemini rédige UNIQUEMENT le commentaire — les chiffres viennent du calcul
async function geminiCommentary(data, calc, betType) {
  const fmt = arr => arr.map(m => `${m.date} ${m.home} ${m.score} ${m.away} (${m.result})`).join(', ') || 'N/D';
  const prompt = `Tu es un analyste football. Les PROBABILITÉS ont déjà été CALCULÉES mathématiquement (modèle de Poisson). Ton rôle : rédiger le commentaire, PAS recalculer les chiffres.

MATCH : ${data.team1Name} vs ${data.team2Name}
PROBABILITÉS CALCULÉES (modèle de Poisson — NE PAS MODIFIER) :
- Victoire ${data.team1Name} : ${(calc.probs.home*100).toFixed(1)}%
- Match nul : ${(calc.probs.draw*100).toFixed(1)}%
- Victoire ${data.team2Name} : ${(calc.probs.away*100).toFixed(1)}%
- Score le plus probable : ${calc.mostLikelyScore}
- Buts attendus : ${calc.lambdaHome.toFixed(2)} - ${calc.lambdaAway.toFixed(2)}

DONNÉES SOURCES :
Forme ${data.team1Name} : ${fmt(data.recent1)}
Forme ${data.team2Name} : ${fmt(data.recent2)}
H2H : ${data.team1Name} ${data.h2h.team1Wins}V-${data.h2h.draws}N-${data.h2h.team2Wins}V ${data.team2Name}

Réponds UNIQUEMENT avec ce JSON (commentaire seulement, sans recalculer) :
{
  "key_factors": ["Facteur 1 expliquant le calcul", "Facteur 2", "Facteur 3"],
  "recent_form": { "team1": "Résumé forme ${data.team1Name}", "team2": "Résumé forme ${data.team2Name}" },
  "h2h": "Résumé H2H en 1 phrase",
  "recommendation": "Conseil basé sur les probabilités calculées, 2 phrases"
}`;
  try {
    return await callGemini(prompt, 1200);
  } catch {
    // Si Gemini échoue, on renvoie un commentaire minimal — les CHIFFRES restent fiables
    return {
      key_factors: ['Probabilités calculées par modèle de Poisson', `Buts attendus : ${calc.lambdaHome.toFixed(1)}-${calc.lambdaAway.toFixed(1)}`, `Score probable : ${calc.mostLikelyScore}`],
      recent_form: { team1: 'Voir données', team2: 'Voir données' },
      h2h: `${data.h2h.team1Wins}-${data.h2h.draws}-${data.h2h.team2Wins}`,
      recommendation: 'Analyse basée sur le modèle mathématique de Poisson.',
    };
  }
}

// Construit le ticket à partir des probabilités calculées
function buildTicket(calc, betType, t1, t2, marketOdds = {}) {
  const p = calc.probs;
  let selection, prob, fairOdds;
  if (betType === 'btts') { selection = 'Les deux équipes marquent'; prob = p.btts; }
  else if (betType === 'over_under') { selection = 'Plus de 2.5 buts'; prob = p.over25; }
  else {
    // 1X2 : on prend l'issue la plus probable
    const max = Math.max(p.home, p.draw, p.away);
    if (max === p.home) { selection = `Victoire ${t1}`; prob = p.home; }
    else if (max === p.away) { selection = `Victoire ${t2}`; prob = p.away; }
    else { selection = 'Match nul'; prob = p.draw; }
  }
  fairOdds = prob > 0 ? Math.round((1/prob)*100)/100 : 0;
  // Cote minimum = cote juste + marge de sécurité 10%
  const oddsMin = Math.round(fairOdds * 1.10 * 100) / 100;
  const stakePct = prob > 0.6 ? 4 : prob > 0.45 ? 3 : 2;
  return {
    type: 'simple', selection,
    prob: Math.round(prob*1000)/10,
    odds_fair: fairOdds, odds_min: oddsMin, stake_pct: stakePct,
    reasoning: `Probabilité calculée ${(prob*100).toFixed(0)}% (Poisson). Misez seulement si la cote ≥ ${oddsMin}.`,
  };
}

function demoResponse(team1, team2, betType) {
  const calc = poissonAnalysis({ homeGoalsForAvg: 2.0, homeGoalsAgainstAvg: 1.0, awayGoalsForAvg: 1.2, awayGoalsAgainstAvg: 1.4 });
  return {
    success: true, isHorse: false, demo: true, version: 'v5',
    match: `${team1} vs ${team2}`, bet_type: betType, data_source: 'MODE DÉMO (Poisson démo)',
    method: 'Poisson (calculé)', most_likely_score: calc.mostLikelyScore,
    probabilities: {
      option1: { label: `Victoire ${team1}`, probability: calc.probs.home, odds_fair: Math.round(1/calc.probs.home*100)/100, ci: confidenceInterval(calc.probs.home, 0.5) },
      option2: { label: 'Match nul', probability: calc.probs.draw, odds_fair: Math.round(1/calc.probs.draw*100)/100, ci: confidenceInterval(calc.probs.draw, 0.5) },
      option3: { label: `Victoire ${team2}`, probability: calc.probs.away, odds_fair: Math.round(1/calc.probs.away*100)/100, ci: confidenceInterval(calc.probs.away, 0.5) },
    },
    confidence: 'moyenne', reliability_pct: 50,
    key_factors: ['Mode démo — probabilités Poisson sur données fictives', 'Configurez les clés pour les vraies données', 'Voir guide'],
    recent_form: { team1: 'Démo', team2: 'Démo' }, h2h: 'Démo', injuries: 'Démo',
    recommendation: 'Démonstration du modèle Poisson v5.',
    ticket: buildTicket(calc, betType, team1, team2),
    _meta: { demo: true, method: 'poisson', fetchedAt: new Date().toISOString() },
  };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { team1, team2, betType = '1X2', demo = false } = req.body || {};
  if (!team1?.trim() || !team2?.trim()) { res.status(400).json({ error: 'team1 et team2 sont requis.' }); return; }

  if (demo) { res.status(200).json(demoResponse(team1.trim(), team2.trim(), betType)); return; }
  if (!process.env.APIFOOTBALL_KEY) { res.status(500).json({ error: 'Variable APIFOOTBALL_KEY manquante. Activez le mode démo pour tester.' }); return; }

  const ck = `v5match:${team1.toLowerCase().trim()}:${team2.toLowerCase().trim()}:${betType}`;
  const cached = cacheGet(ck);
  if (cached) { res.status(200).json({ ...cached, _meta: { ...cached._meta, cached: true, cacheAgeSec: cacheAge(ck) } }); return; }

  try {
    const [t1, t2] = await Promise.all([findTeamId(team1), findTeamId(team2)]);
    const [recent1, recent2, h2h] = await Promise.all([getRecentFixtures(t1.id), getRecentFixtures(t2.id), getH2H(t1.id, t2.id)]);
    const leagueId = recent1[0]?.leagueId, season = recent1[0]?.season;
    const [stats1, stats2] = leagueId && season
      ? await Promise.all([getTeamStats(t1.id, leagueId, season), getTeamStats(t2.id, leagueId, season)])
      : [null, null];

    // Moyennes de buts : priorité aux stats domicile/extérieur, sinon fixtures
    const home1 = recent1.filter(f => f.isHome), away2 = recent2.filter(f => !f.isHome);
    const a1 = stats1 ? { gf: stats1.goalsForHome || stats1.goalsForAvg, ga: stats1.goalsAgainstHome || stats1.goalsAgainstAvg } : avgFromFixtures(home1.length ? home1 : recent1);
    const a2 = stats2 ? { gf: stats2.goalsForAway || stats2.goalsForAvg, ga: stats2.goalsAgainstAway || stats2.goalsAgainstAvg } : avgFromFixtures(away2.length ? away2 : recent2);

    // CALCUL POISSON (déterministe)
    const calc = poissonAnalysis({
      homeGoalsForAvg: a1.gf, homeGoalsAgainstAvg: a1.ga,
      awayGoalsForAvg: a2.gf, awayGoalsAgainstAvg: a2.ga,
    });

    // Fiabilité
    const reliability = footballReliability({ recent1Count: recent1.length, recent2Count: recent2.length, hasStats: !!(stats1 && stats2), h2hCount: h2h.recentMatches.length });

    // Commentaire IA (chiffres déjà calculés)
    const commentary = await geminiCommentary({ team1Name: t1.name, team2Name: t2.name, recent1, recent2, h2h }, calc, betType);

    // Fourchettes + niveau de confiance
    const ciHome = confidenceInterval(calc.probs.home, reliability);
    const ciDraw = confidenceInterval(calc.probs.draw, reliability);
    const ciAway = confidenceInterval(calc.probs.away, reliability);
    const conf = confidenceLevel(reliability, false);

    const result = {
      success: true, isHorse: false, version: 'v5',
      match: `${t1.name} vs ${t2.name}`, bet_type: betType,
      data_source: 'API-Football + Poisson (calculé)',
      method: 'Modèle de Poisson', most_likely_score: calc.mostLikelyScore,
      expected_goals: { home: Math.round(calc.lambdaHome*100)/100, away: Math.round(calc.lambdaAway*100)/100 },
      probabilities: {
        option1: { label: `Victoire ${t1.name}`, probability: calc.probs.home, odds_fair: Math.round(1/calc.probs.home*100)/100, ci: ciHome },
        option2: { label: 'Match nul', probability: calc.probs.draw, odds_fair: Math.round(1/calc.probs.draw*100)/100, ci: ciDraw },
        option3: { label: `Victoire ${t2.name}`, probability: calc.probs.away, odds_fair: Math.round(1/calc.probs.away*100)/100, ci: ciAway },
      },
      extra_markets: {
        btts: Math.round(calc.probs.btts*1000)/10,
        over25: Math.round(calc.probs.over25*1000)/10,
        under25: Math.round(calc.probs.under25*1000)/10,
      },
      confidence: conf,
      reliability_pct: Math.round(reliability*100),
      ...commentary,
      ticket: buildTicket(calc, betType, t1.name, t2.name),
      _meta: { method: 'poisson', team1Id: t1.id, team2Id: t2.id, reliability: Math.round(reliability*100), fetchedAt: new Date().toISOString(),
        dataPoints: { recent1: recent1.length, recent2: recent2.length, h2hMatches: h2h.recentMatches.length, hasStats: !!(stats1 && stats2) } },
    };
    cacheSet(ck, result);
    res.status(200).json(result);
  } catch (err) {
    console.error('[v5 football]', err.message);
    res.status(500).json({ error: err.message });
  }
}
