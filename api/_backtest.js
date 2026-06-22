// ════════════════════════════════════════════════════════════════════
// BACKTESTING — enregistre les pronostics et mesure la calibration
// ════════════════════════════════════════════════════════════════════
// Note: stockage en mémoire (instance Vercel). Pour un vrai backtesting
// persistant, le frontend sauvegarde aussi dans localStorage et peut
// renvoyer les résultats vérifiés. Ici on fournit les outils de calcul.

const _predictions = [];
const MAX_PREDICTIONS = 500;

// Enregistre un pronostic
export function recordPrediction(pred) {
  // pred = { id, sport, type, selection, predictedProb, date, eventDate }
  _predictions.push({ ...pred, recordedAt: Date.now(), verified: false, won: null });
  if (_predictions.length > MAX_PREDICTIONS) _predictions.shift();
  return pred.id;
}

// Marque un pronostic comme vérifié
export function verifyPrediction(id, won) {
  const p = _predictions.find(x => x.id === id);
  if (p) { p.verified = true; p.won = won; }
  return !!p;
}

// Calcule la calibration : pour chaque tranche de proba, taux de réussite réel
export function computeCalibration(predictions) {
  const verified = predictions.filter(p => p.verified);
  if (verified.length === 0) return { buckets: [], totalVerified: 0, brier: null };

  // Tranches de 10% : 0-10, 10-20, ..., 90-100
  const buckets = [];
  for (let i = 0; i < 10; i++) {
    const low = i / 10, high = (i + 1) / 10;
    const inBucket = verified.filter(p => p.predictedProb >= low && p.predictedProb < high);
    if (inBucket.length === 0) continue;
    const wins = inBucket.filter(p => p.won).length;
    const actualRate = wins / inBucket.length;
    const avgPredicted = inBucket.reduce((s, p) => s + p.predictedProb, 0) / inBucket.length;
    buckets.push({
      range: `${i*10}-${(i+1)*10}%`,
      count: inBucket.length,
      predicted: Math.round(avgPredicted * 100),
      actual: Math.round(actualRate * 100),
      gap: Math.round((actualRate - avgPredicted) * 100),
    });
  }

  // Score de Brier : mesure globale de précision (plus bas = mieux, 0 = parfait)
  const brier = verified.reduce((s, p) => s + Math.pow(p.predictedProb - (p.won ? 1 : 0), 2), 0) / verified.length;

  return { buckets, totalVerified: verified.length, brier: Math.round(brier * 1000) / 1000 };
}

// Calcule le ROI théorique si on avait misé sur tous les value bets
export function computeROI(predictions) {
  const verified = predictions.filter(p => p.verified && p.marketOdds);
  if (verified.length === 0) return { roi: null, bets: 0 };
  let staked = 0, returned = 0;
  verified.forEach(p => {
    staked += 1; // mise unitaire
    if (p.won) returned += p.marketOdds; // on récupère mise × cote
  });
  const roi = staked > 0 ? ((returned - staked) / staked) * 100 : 0;
  return { roi: Math.round(roi * 10) / 10, bets: verified.length, staked, returned: Math.round(returned * 10) / 10 };
}

export function getPredictions() { return _predictions.slice(); }
