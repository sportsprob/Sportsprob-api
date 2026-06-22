// ════════════════════════════════════════════════════════════════════
// MODÈLES MATHÉMATIQUES v5 — probabilités calculées (déterministes)
// ════════════════════════════════════════════════════════════════════

// ── POISSON (FOOTBALL) ────────────────────────────────────────────────
function factorial(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
function poissonProb(k, lambda) { return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k); }

export function computeLambdas(stats) {
  const {
    homeGoalsForAvg, homeGoalsAgainstAvg,
    awayGoalsForAvg, awayGoalsAgainstAvg,
    leagueAvg = 1.4, homeAdvantage = 1.15,
  } = stats;
  const homeAttack = homeGoalsForAvg / leagueAvg;
  const homeDefense = homeGoalsAgainstAvg / leagueAvg;
  const awayAttack = awayGoalsForAvg / leagueAvg;
  const awayDefense = awayGoalsAgainstAvg / leagueAvg;
  const lambdaHome = homeAttack * awayDefense * leagueAvg * homeAdvantage;
  const lambdaAway = awayAttack * homeDefense * leagueAvg;
  return {
    lambdaHome: Math.max(0.2, Math.min(lambdaHome, 5)),
    lambdaAway: Math.max(0.2, Math.min(lambdaAway, 5)),
  };
}

export function poissonAnalysis(stats) {
  const { lambdaHome, lambdaAway } = computeLambdas(stats);
  const maxGoals = 8;
  const matrix = [];
  for (let h = 0; h <= maxGoals; h++) {
    matrix[h] = [];
    for (let a = 0; a <= maxGoals; a++) matrix[h][a] = poissonProb(h, lambdaHome) * poissonProb(a, lambdaAway);
  }
  let pHome = 0, pDraw = 0, pAway = 0, pBtts = 0, pOver25 = 0, pUnder25 = 0, total = 0;
  let bestScore = { h: 0, a: 0, p: 0 };
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = matrix[h][a];
      total += p;
      if (h > a) pHome += p; else if (h === a) pDraw += p; else pAway += p;
      if (h > 0 && a > 0) pBtts += p;
      if (h + a > 2.5) pOver25 += p; else pUnder25 += p;
      if (p > bestScore.p && h <= 5 && a <= 5) bestScore = { h, a, p };
    }
  }
  const n = total > 0 ? total : 1;
  return {
    lambdaHome, lambdaAway,
    mostLikelyScore: `${bestScore.h}-${bestScore.a}`,
    probs: {
      home: pHome / n, draw: pDraw / n, away: pAway / n,
      btts: pBtts / n, over25: pOver25 / n, under25: pUnder25 / n,
    },
  };
}

// ── SCORE-MUSIQUE (HIPPIQUE) ──────────────────────────────────────────
const POS_POINTS = { '1': 25, '2': 18, '3': 12, '4': 8, '5': 5, '6': 3, '7': 2, '8': 1, '9': 1, '0': 0 };
const FAIL_CHARS = ['D', 'T', 'A', 'R', 'Q'];
const DISCIPLINE_CHARS = ['A', 'M', 'P', 'H', 'C', 'S'];

export function parseMusique(music) {
  if (!music || music === '—') return [];
  const results = [];
  const clean = String(music).replace(/[()\s]/g, '');
  let i = 0;
  while (i < clean.length) {
    const ch = clean[i].toUpperCase();
    if (/[0-9]/.test(ch)) {
      results.push({ fail: false, position: ch, points: POS_POINTS[ch] ?? 0 });
      i++;
      if (i < clean.length && DISCIPLINE_CHARS.includes(clean[i].toUpperCase())) i++;
    } else if (FAIL_CHARS.includes(ch)) {
      results.push({ fail: true, points: 0 });
      i++;
      if (i < clean.length && DISCIPLINE_CHARS.includes(clean[i].toUpperCase())) i++;
    } else { i++; }
  }
  return results;
}

export function formScore(music) {
  const results = parseMusique(music);
  if (results.length === 0) return { score: 0, races: 0, reliability: 0, regularity: 0, top3: 0 };
  let weightedSum = 0, weightTotal = 0;
  results.forEach((r, i) => { const w = Math.pow(0.85, i); weightedSum += r.points * w; weightTotal += w; });
  const score = weightTotal > 0 ? weightedSum / weightTotal : 0;
  const reliability = Math.min(results.length / 6, 1);
  const top3 = results.filter(r => !r.fail && ['1','2','3'].includes(r.position)).length;
  const regularity = results.length > 0 ? top3 / results.length : 0;
  return { score, races: results.length, reliability, regularity, top3 };
}

// horses = [{ number, name, music, odds }]
export function musiqueAnalysis(horses) {
  const scored = horses.map(h => {
    const f = formScore(h.music);
    const adjustedScore = f.score * (1 + f.regularity * 0.3);
    return { ...h, formData: f, adjustedScore };
  });
  const total = scored.reduce((s, h) => s + Math.max(h.adjustedScore, 0.1), 0);
  scored.forEach(h => {
    h.probability = Math.max(h.adjustedScore, 0.1) / total;
    h.odds_fair = h.probability > 0 ? Math.round((1 / h.probability) * 100) / 100 : 99;
  });
  // Fiabilité moyenne pondérée
  const avgReliability = scored.reduce((s, h) => s + h.formData.reliability, 0) / (scored.length || 1);
  return { horses: scored.sort((a, b) => b.probability - a.probability), avgReliability };
}

// ── CROISEMENT COTES ──────────────────────────────────────────────────
export function crossCheck(calcProb, marketOdds) {
  if (!marketOdds || marketOdds <= 1) return { value: false, edge: 0, marketProb: null, bigDivergence: false };
  const marketProb = 1 / marketOdds;
  const edge = calcProb - marketProb;
  return {
    marketProb, edge,
    value: edge > 0.05,
    bigDivergence: Math.abs(edge) > 0.25,
    edgePct: Math.round(edge * 1000) / 10,
  };
}

// ── FOURCHETTES D'INCERTITUDE ─────────────────────────────────────────
export function confidenceInterval(prob, reliability) {
  const baseMargin = 0.12;
  const margin = baseMargin * (1 - reliability * 0.7);
  return {
    low: Math.max(0, prob - margin),
    high: Math.min(1, prob + margin),
    lowPct: Math.round(Math.max(0, prob - margin) * 100),
    highPct: Math.round(Math.min(1, prob + margin) * 100),
    margin: Math.round(margin * 1000) / 10,
  };
}

export function confidenceLevel(reliability, bigDivergence) {
  if (bigDivergence) return 'faible';
  if (reliability >= 0.8) return 'élevée';
  if (reliability >= 0.5) return 'moyenne';
  return 'faible';
}

// ── ESTIMATION FIABILITÉ DONNÉES FOOTBALL ─────────────────────────────
// Basée sur le nombre de matchs récents disponibles + présence de stats
export function footballReliability({ recent1Count, recent2Count, hasStats, h2hCount }) {
  let r = 0;
  r += Math.min(recent1Count, 5) / 5 * 0.3;
  r += Math.min(recent2Count, 5) / 5 * 0.3;
  r += hasStats ? 0.25 : 0;
  r += Math.min(h2hCount, 5) / 5 * 0.15;
  return Math.min(r, 1);
}

// ════════════════════════════════════════════════════════════════════
// MODÈLE HANDICAPEUR AVANCÉ (saisie manuelle) — multi-facteurs
// ════════════════════════════════════════════════════════════════════

// Score de forme enrichi (tendance, régularité, taux de disqualification)
export function formScoreAdvanced(music, maxRaces = 6) {
  const all = parseMusique(music);
  const results = all.slice(0, maxRaces);
  if (results.length === 0) return { score: 0, races: 0, reliability: 0, regularity: 0, dqRate: 0, trend: 0 };
  let weightedSum = 0, weightTotal = 0;
  results.forEach((r, i) => { const w = Math.pow(0.82, i); weightedSum += r.points * w; weightTotal += w; });
  const score = weightTotal > 0 ? weightedSum / weightTotal : 0;
  const reliability = Math.min(results.length / 5, 1);
  const top3 = results.filter(r => !r.fail && ['1','2','3'].includes(r.position)).length;
  const regularity = top3 / results.length;
  const dqRate = results.filter(r => r.fail).length / results.length;
  const half = Math.floor(results.length / 2);
  let trend = 0;
  if (half >= 1) {
    const recent = results.slice(0, half), older = results.slice(half);
    const ra = recent.reduce((s, r) => s + r.points, 0) / recent.length;
    const oa = older.reduce((s, r) => s + r.points, 0) / older.length;
    trend = Math.max(-1, Math.min(1, (ra - oa) / 15));
  }
  return { score, races: results.length, reliability, regularity, dqRate, trend };
}

export function freshnessMultiplier(daysSince) {
  if (daysSince == null) return 1.0;
  if (daysSince < 5) return 0.96;
  if (daysSince <= 30) return 1.0;
  if (daysSince <= 50) return 0.98;
  if (daysSince <= 90) return 0.93;
  return 0.85;
}

export function advancedScore(horse, ctx = {}) {
  const { discipline = 'trot', fieldAvgWeight = null } = ctx;
  const form = formScoreAdvanced(horse.music, 6);
  const base = Math.max(form.score, 0.1);
  const trendMult = 1 + form.trend * 0.12;
  const distMult = horse.distanceApt === 2 ? 1.15 : horse.distanceApt === 1 ? 1.05 : horse.distanceApt === 0 ? 0.90 : 1.0;
  const courseMult = horse.courseApt === 2 ? 1.15 : horse.courseApt === 1 ? 1.05 : horse.courseApt === 0 ? 0.95 : 1.0;
  const freshMult = freshnessMultiplier(horse.daysSince);
  const connMult = horse.topDriver ? 1.10 : 1.0;
  const classMult = horse.classMove === -1 ? 1.10 : horse.classMove === 1 ? 0.93 : 1.0;
  let posMult = 1.0;
  if (discipline === 'trot' && horse.draw != null) posMult = horse.draw <= 3 ? 1.06 : horse.draw <= 6 ? 1.0 : 0.95;
  let weightMult = 1.0;
  if (discipline === 'galop' && horse.weight != null && fieldAvgWeight) {
    weightMult = Math.max(0.9, Math.min(1.1, 1 - ((horse.weight - fieldAvgWeight) / 100)));
  }
  let dqMult = 1.0;
  if (discipline === 'trot') dqMult = 1 - form.dqRate * 0.30;

  // CORRECTION : weightMult est bien inclus dans le produit
  const adjusted = base * trendMult * distMult * courseMult * freshMult * connMult * classMult * posMult * weightMult * dqMult;

  const provided = [horse.distanceApt, horse.courseApt, horse.daysSince, horse.topDriver, horse.classMove, horse.draw, horse.weight].filter(x => x != null && x !== false).length;
  const dataCompleteness = Math.min(provided / 4, 1);
  return {
    ...horse, baseScore: form.score, adjustedScore: Math.max(adjusted, 0.05), form, dataCompleteness,
    multipliers: { trend: trendMult, dist: distMult, course: courseMult, fresh: freshMult, conn: connMult, class: classMult, pos: posMult, weight: weightMult, dq: dqMult },
  };
}

export function advancedAnalysis(horses, ctx = {}) {
  const weights = horses.map(h => h.weight).filter(w => w != null);
  const fieldAvgWeight = weights.length ? weights.reduce((a, b) => a + b, 0) / weights.length : null;
  const context = { ...ctx, fieldAvgWeight };
  const scored = horses.map(h => advancedScore(h, context));
  const total = scored.reduce((s, h) => s + h.adjustedScore, 0) || 1;
  scored.forEach(h => {
    h.probability = h.adjustedScore / total;
    h.odds_fair = h.probability > 0 ? Math.round((1 / h.probability) * 100) / 100 : 99;
  });
  const avgReliability = scored.reduce((s, h) => s + h.form.reliability, 0) / (scored.length || 1);
  const avgCompleteness = scored.reduce((s, h) => s + h.dataCompleteness, 0) / (scored.length || 1);
  return { horses: scored.sort((a, b) => b.probability - a.probability), avgReliability, avgCompleteness };
}
