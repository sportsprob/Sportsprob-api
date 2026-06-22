import {
  cacheGet, cacheSet, cacheAge, withRetry, fetchWithTimeout, callGemini,
} from './_lib.js';
import {
  musiqueAnalysis, crossCheck, confidenceInterval, confidenceLevel, advancedAnalysis,
} from './_models.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function toYMD(dateStr) {
  if (!dateStr) { const n = new Date(); return [n.getFullYear(), String(n.getMonth()+1).padStart(2,'0'), String(n.getDate()).padStart(2,'0')]; }
  if (dateStr.includes('/')) { const [d,m,y] = dateStr.split('/'); return [y, m.padStart(2,'0'), d.padStart(2,'0')]; }
  return dateStr.split('-');
}

const PMU_HEADERS = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120', 'Accept-Language': 'fr-FR,fr;q=0.9' };

async function pmuFetch(url, label = 'PMU') {
  return withRetry(async () => {
    const res = await fetchWithTimeout(url, { headers: PMU_HEADERS }, 12000);
    if (res.status === 403 || res.status === 401) throw new Error('PMU bloque temporairement l\'accès. Réessayez dans quelques minutes.');
    if (res.status === 404) throw new Error(`${label} introuvable (404).`);
    if (!res.ok) throw new Error(`PMU ${label}: HTTP ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) throw new Error('PMU a renvoyé un format inattendu.');
    return res.json();
  }, { retries: 2, delayMs: 900, label });
}

const extractReunions = d => d?.programme?.reunions || d?.reunions || d?.programme?.listReunions || [];
const extractCourses = r => r?.courses || r?.listCourses || [];
const extractParticipants = raw => Array.isArray(raw) ? raw : (raw?.participants || raw?.listParticipants || raw?.partants || []);

async function fetchProgramme(dateStr) {
  const [y, m, d] = toYMD(dateStr);
  const ck = `prog:${y}${m}${d}`;
  const c = cacheGet(ck); if (c) return { reunions: c, y, m, d };
  const data = await pmuFetch(`https://online.pmu.fr/services/rest/program/${y}/${m}/${d}`, 'programme');
  const reunions = extractReunions(data);
  if (!reunions.length) throw new Error(`Aucune réunion PMU pour le ${d}/${m}/${y}.`);
  cacheSet(ck, reunions); return { reunions, y, m, d };
}

function listAvailableRaces(reunions) {
  return reunions.flatMap(r => extractCourses(r).map(c => `R${r.numOfficiel} ${r.hippodrome?.libelleAbrege||''}: ${c.libelleLong||c.libelleCourt}`)).slice(0, 10);
}

function findRace(reunions, raceName) {
  const kw = raceName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  let best = null, bestScore = 0;
  for (const r of reunions) for (const c of extractCourses(r)) {
    const hay = [c.libelleLong||'', c.libelleCourt||''].join(' ').toLowerCase();
    const score = kw.filter(k => hay.includes(k)).length;
    if (score > bestScore) { bestScore = score; best = { course: c, reunion: r }; }
  }
  if (!best || bestScore === 0) {
    if (/quint[ée]/i.test(raceName)) for (const r of reunions) for (const c of extractCourses(r))
      if (c.categorieParticularite === 'QUINTE_PLUS' || (c.libelleLong||'').toLowerCase().includes('quinté')) return { course: c, reunion: r };
    return null;
  }
  return best;
}

async function fetchParticipants(y, m, d, numR, numC) {
  const raw = await pmuFetch(`https://online.pmu.fr/services/rest/program/${y}/${m}/${d}/R${numR}/C${numC}/participants`, 'participants');
  return extractParticipants(raw);
}

async function fetchOdds(y, m, d, numR, numC) {
  try {
    const raw = await pmuFetch(`https://online.pmu.fr/services/rest/program/${y}/${m}/${d}/R${numR}/C${numC}/cotes-simples-gagnant`, 'cotes');
    const arr = Array.isArray(raw) ? raw : (raw?.cotesSimples || raw?.cotes || []);
    const map = {};
    arr.forEach(c => { const n = c.numCheval || c.numPmu; const r = c.rapport || c.cote || c.dernierRapport; if (n && r) map[n] = r > 50 ? r/100 : r; });
    return map;
  } catch { return {}; }
}

function parseHorse(p, oddsMap) {
  return {
    number: p.numCheval || p.numPmu, name: p.nom || '—', age: p.age, sex: p.sexe,
    weight: p.poidsConditionCourse || p.poids || null,
    driver: p.driver?.nom || p.jockey?.nom || p.driverNom || '—',
    trainer: p.entraineur?.nom || p.entraineurNom || '—',
    music: p.musique || p.derniersCourses || '—',
    distanceOptimal: p.distanceCourse || null,
    odds: oddsMap[p.numCheval || p.numPmu] || null,
  };
}

// Gemini rédige le commentaire — scores déjà calculés
async function geminiCommentary(courseData, scoredHorses, sportType) {
  const top = scoredHorses.slice(0, 5).map(h => `N°${h.number} ${h.name}: ${(h.probability*100).toFixed(1)}% (musique ${h.music}, score forme ${h.formData.score.toFixed(1)})`).join('\n');
  const prompt = `Tu es un expert hippique. Les PROBABILITÉS ont déjà été CALCULÉES via un modèle de score-musique. Ton rôle : commenter, PAS recalculer.

COURSE : ${courseData.raceName} (${sportType}, ${courseData.distance}m, ${courseData.hippodrome})

PROBABILITÉS CALCULÉES (NE PAS MODIFIER) :
${top}

Réponds UNIQUEMENT avec ce JSON :
{
  "race_conditions": "Résumé conditions",
  "horse_comments": { "${scoredHorses[0]?.number}": "commentaire bref", "${scoredHorses[1]?.number}": "commentaire bref" },
  "key_factors": ["Facteur 1", "Facteur 2", "Facteur 3"],
  "recommendation": "Conseil basé sur les scores calculés, 2 phrases"
}`;
  try { return await callGemini(prompt, 1500); }
  catch {
    return { race_conditions: `${courseData.hippodrome} ${courseData.distance}m`, horse_comments: {}, key_factors: ['Probabilités calculées par score-musique', 'Forme pondérée par récence', 'Régularité prise en compte'], recommendation: 'Analyse basée sur le modèle de score-musique.' };
  }
}

function buildTicket(scored, betType) {
  const sorted = scored.slice().sort((a,b) => b.probability - a.probability);
  const base = sorted.slice(0, 1).map(h => String(h.number));
  const chevaux = sorted.slice(1, 4).map(h => String(h.number));
  // Outsider = meilleure value (cote PMU > cote juste)
  const valueHorses = sorted.filter(h => h.crossData?.value).map(h => String(h.number));
  const outsider = sorted.slice(4).filter(h => h.crossData?.value).slice(0, 1).map(h => String(h.number));
  const ordre = sorted.slice(0, 5).map(h => String(h.number));
  return {
    bet_type: betType, base, chevaux, outsider, ordre_conseil: ordre,
    combinaisons: betType === 'quinte' ? 120 : betType === 'quarte' ? 24 : betType === 'tierce' ? 6 : 1,
    cost_estimate: betType === 'quinte' ? '1€ × 120 = 120€ (réduire les chevaux pour baisser)' : '1€ de base',
    stake_advice: 'Mise de base 1€. Réduisez le nombre de chevaux selon votre budget.',
    value_numbers: valueHorses,
    reading: `Base : ${base.join(',')}. Chevaux : ${chevaux.join(',')}. ${outsider.length ? 'Outsider value : '+outsider.join(',')+'.' : ''} Scores calculés par modèle musique.`,
  };
}

function demoResponse(raceName, sport, betType) {
  const { horses: scored } = musiqueAnalysis([
    { number: 5, name: 'DEMO BASE', music: '1a1a2a1a', odds: 4.0 },
    { number: 3, name: 'DEMO CHEVAL', music: '2a1a3a2a', odds: 3.5 },
    { number: 7, name: 'DEMO OUTSIDER', music: '3a4a2a5a', odds: 9.0 },
  ]);
  scored.forEach(h => { h.crossData = crossCheck(h.probability, h.odds); });
  return {
    success: true, isHorse: true, demo: true, version: 'v5',
    race: raceName, sport, bet_type: betType, data_source: 'MODE DÉMO (score-musique démo)',
    method: 'Score-musique (calculé)', race_conditions: 'Démonstration',
    horses: scored.map(h => ({ number: h.number, name: h.name, probability: h.probability, odds_fair: h.odds_fair, odds_market: h.odds, is_value: h.crossData.value, form: `Musique ${h.music} (score ${h.formData.score.toFixed(1)})`, driver_trainer: 'Démo', ground_preference: 'Tous', distance_optimal: '2700m', strengths: h.formData.regularity > 0.7 ? ['Régulier'] : [], weaknesses: [], rating: Math.round(h.formData.score/3), ci: confidenceInterval(h.probability, h.formData.reliability) })),
    top_selection: scored.slice(0,2).map(h => String(h.number)),
    confidence: 'moyenne', reliability_pct: 67,
    key_factors: ['Mode démo — score-musique sur données fictives', 'Configurez les clés pour les vraies données', 'Voir guide'],
    recommendation: 'Démonstration du modèle score-musique v5.',
    value_bet: scored.find(h => h.crossData.value) ? `N°${scored.find(h => h.crossData.value).number}` : 'Aucun',
    ticket: buildTicket(scored, betType),
    _meta: { demo: true, method: 'musique', fetchedAt: new Date().toISOString() },
  };
}

// ── ANALYSE MANUELLE (modèle avancé) ──────────────────────────────────
function analyzeManual(manualHorses, { raceName, sport, betType }) {
  // Normalise les entrées manuelles
  const horses = manualHorses.map(h => ({
    number: parseInt(h.number) || 0,
    name: h.name?.trim() || `N°${h.number}`,
    music: h.music?.trim() || '—',
    odds: h.odds ? parseFloat(h.odds) : null,
    weight: h.weight ? parseFloat(h.weight) : null,
    draw: h.draw != null && h.draw !== '' ? parseInt(h.draw) : null,
    daysSince: h.daysSince != null && h.daysSince !== '' ? parseInt(h.daysSince) : null,
    distanceApt: h.distanceApt != null && h.distanceApt !== '' ? parseInt(h.distanceApt) : null,
    courseApt: h.courseApt != null && h.courseApt !== '' ? parseInt(h.courseApt) : null,
    topDriver: h.topDriver === true || h.topDriver === 'true' || h.topDriver === 1,
    classMove: h.classMove != null && h.classMove !== '' ? parseInt(h.classMove) : null,
  })).filter(h => h.number > 0);

  if (!horses.length) throw new Error('Aucun cheval valide. Vérifiez au moins le numéro et la musique.');

  const { horses: scored, avgReliability, avgCompleteness } = advancedAnalysis(horses, { discipline: sport });
  scored.forEach(h => { h.crossData = crossCheck(h.probability, h.odds); });

  const conf = confidenceLevel(avgReliability * 0.6 + avgCompleteness * 0.4, false);

  return {
    success: true, isHorse: true, version: 'v5', manual: true,
    race: raceName?.trim() || 'Course (saisie manuelle)', sport, bet_type: betType,
    data_source: 'SAISIE MANUELLE + Modèle avancé', method: 'Modèle handicapeur avancé',
    race_conditions: `Analyse manuelle — ${horses.length} partants`,
    horses: scored.map(h => {
      const m = h.multipliers;
      const factorNotes = [];
      if (m.dist > 1) factorNotes.push('apte distance');
      if (m.dist < 1) factorNotes.push('distance non prouvée');
      if (m.course > 1) factorNotes.push('apte hippodrome');
      if (m.fresh < 1) factorNotes.push('fraîcheur moyenne');
      if (m.conn > 1) factorNotes.push('driver de pointe');
      if (m.class > 1) factorNotes.push('descend de catégorie');
      if (m.dq < 0.95) factorNotes.push('risque de faute');
      if (h.form.trend > 0.2) factorNotes.push('forme montante');
      if (h.form.trend < -0.2) factorNotes.push('forme descendante');
      return {
        number: h.number, name: h.name, probability: h.probability, odds_fair: h.odds_fair,
        odds_market: h.odds, is_value: h.crossData.value,
        form: `Musique ${h.music} — score ${h.form.score.toFixed(1)}/25 (${h.form.races} courses, ${Math.round(h.form.regularity*100)}% top 3${h.form.dqRate > 0 ? ', '+Math.round(h.form.dqRate*100)+'% fautes' : ''})`,
        driver_trainer: h.topDriver ? 'Driver/jockey de pointe' : '—',
        ground_preference: factorNotes.length ? factorNotes.join(', ') : '—',
        distance_optimal: '—',
        strengths: [...(h.form.regularity > 0.6 ? ['Régulier'] : []), ...(h.crossData.value ? ['Value PMU'] : []), ...(m.dist > 1 || m.course > 1 ? ['Apte au parcours'] : [])],
        weaknesses: [...(h.form.score < 5 ? ['Forme faible'] : []), ...(m.dq < 0.95 ? ['Fautes récentes'] : [])],
        rating: Math.min(Math.round(h.adjustedScore / 2.5), 10),
        ci: confidenceInterval(h.probability, h.form.reliability),
      };
    }),
    top_selection: scored.slice(0, 3).map(h => String(h.number)),
    confidence: conf, reliability_pct: Math.round(avgReliability * 100),
    data_completeness_pct: Math.round(avgCompleteness * 100),
    key_factors: [
      `Probabilités calculées sur ${horses.length} partants (modèle multi-facteurs)`,
      `Complétude des données : ${Math.round(avgCompleteness*100)}% (plus vous renseignez, plus c'est précis)`,
      'Forme, aptitude parcours, fraîcheur, driver et catégorie pris en compte',
    ],
    recommendation: 'Analyse par modèle handicapeur avancé sur vos données saisies.',
    value_bet: scored.find(h => h.crossData.value) ? `N°${scored.find(h => h.crossData.value).number} (cote PMU ${scored.find(h => h.crossData.value).odds} > cote juste ${scored.find(h => h.crossData.value).odds_fair})` : 'Aucun value bet (ajoutez les cotes PMU pour les détecter)',
    ticket: buildTicket(scored, betType),
    _meta: { method: 'advanced_manual', totalRunners: horses.length, reliability: Math.round(avgReliability*100), completeness: Math.round(avgCompleteness*100), fetchedAt: new Date().toISOString() },
  };
}

async function geminiCommentaryManual(result, sportType, raceName) {
  const top = result.horses.slice(0, 5).map(h => `N°${h.number} ${h.name}: ${(h.probability*100).toFixed(1)}%`).join('\n');
  const prompt = `Expert hippique. Probabilités CALCULÉES par modèle avancé (NE PAS recalculer). Rédige le commentaire.

COURSE : ${raceName || 'course'} (${sportType})
TOP CALCULÉ :
${top}

JSON uniquement :
{ "key_factors": ["Facteur 1", "Facteur 2", "Facteur 3"], "recommendation": "Conseil 2 phrases basé sur les probas calculées" }`;
  return await callGemini(prompt, 800);
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { raceName, raceDate, sport = 'trot', betType = 'gagnant', selectedHorses, demo = false, manualHorses } = req.body || {};

  // ── MODE SAISIE MANUELLE : bypass complet du scraper PMU ──
  if (Array.isArray(manualHorses) && manualHorses.length > 0) {
    try {
      const result = analyzeManual(manualHorses, { raceName, sport, betType });
      // Commentaire IA optionnel (si clé dispo) — sinon analyse pure maths
      if (process.env.GEMINI_API_KEY) {
        try {
          const commentary = await geminiCommentaryManual(result, sport, raceName);
          Object.assign(result, commentary);
        } catch { /* maths restent valides sans IA */ }
      }
      res.status(200).json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  if (!raceName?.trim()) { res.status(400).json({ error: 'raceName est requis (ou utilisez la saisie manuelle).' }); return; }

  if (demo) { res.status(200).json(demoResponse(raceName.trim(), sport, betType)); return; }

  const ck = `v5race:${raceName.toLowerCase().trim()}:${raceDate||'today'}:${sport}:${betType}:${selectedHorses||'all'}`;
  const cached = cacheGet(ck);
  if (cached) { res.status(200).json({ ...cached, _meta: { ...cached._meta, cached: true, cacheAgeSec: cacheAge(ck) } }); return; }

  try {
    const { reunions, y, m, d } = await fetchProgramme(raceDate);
    const found = findRace(reunions, raceName);
    if (!found) throw new Error(`Course "${raceName}" introuvable. Courses du jour : ${listAvailableRaces(reunions).join(' | ')}`);
    const { course, reunion } = found;
    const numR = reunion.numOfficiel, numC = course.numOrdre;

    const [rawP, oddsMap] = await Promise.all([fetchParticipants(y, m, d, numR, numC), fetchOdds(y, m, d, numR, numC)]);
    if (!rawP.length) throw new Error('Aucun partant trouvé pour cette course.');

    let horses = rawP.map(p => parseHorse(p, oddsMap)).filter(h => h.number);
    if (selectedHorses?.trim()) {
      const nums = selectedHorses.split(/[\s,;]+/).map(n => parseInt(n.trim())).filter(n => !isNaN(n) && n > 0);
      if (nums.length) horses = horses.filter(h => nums.includes(h.number));
    }
    if (!horses.length) throw new Error('Aucun partant correspondant aux numéros indiqués.');

    // CALCUL SCORE-MUSIQUE (déterministe)
    const { horses: scored, avgReliability } = musiqueAnalysis(horses);
    scored.forEach(h => { h.crossData = crossCheck(h.probability, h.odds); });

    const courseData = {
      raceName: course.libelleLong || course.libelleCourt || raceName,
      hippodrome: reunion.hippodrome?.libelleLong || reunion.hippodrome?.libelleAbrege || '—',
      distance: course.distance || '—', y, m, d,
    };

    const commentary = await geminiCommentary(courseData, scored, sport);
    const conf = confidenceLevel(avgReliability, false);

    const result = {
      success: true, isHorse: true, version: 'v5',
      race: courseData.raceName, sport, bet_type: betType,
      data_source: 'PMU.fr + Score-musique (calculé)', method: 'Modèle score-musique',
      race_conditions: commentary.race_conditions || `${courseData.hippodrome} ${courseData.distance}m`,
      horses: scored.map(h => ({
        number: h.number, name: h.name, probability: h.probability, odds_fair: h.odds_fair,
        odds_market: h.odds, is_value: h.crossData.value,
        form: `Musique ${h.music} — score forme ${h.formData.score.toFixed(1)}/25 (${h.formData.races} courses, ${Math.round(h.formData.regularity*100)}% top 3)`,
        driver_trainer: `${h.driver}${h.trainer !== '—' ? ' / '+h.trainer : ''}`,
        ground_preference: '—', distance_optimal: h.distanceOptimal ? h.distanceOptimal+'m' : '—',
        strengths: [...(h.formData.regularity > 0.6 ? ['Régulier'] : []), ...(h.crossData.value ? ['Value PMU'] : [])],
        weaknesses: h.formData.score < 5 ? ['Forme faible'] : [],
        rating: Math.min(Math.round(h.formData.score/2.5), 10),
        ci: confidenceInterval(h.probability, h.formData.reliability),
        comment: commentary.horse_comments?.[h.number] || null,
      })),
      top_selection: scored.slice(0, 3).map(h => String(h.number)),
      confidence: conf, reliability_pct: Math.round(avgReliability*100),
      key_factors: commentary.key_factors || [],
      recommendation: commentary.recommendation || 'Analyse par score-musique.',
      value_bet: scored.find(h => h.crossData.value) ? `N°${scored.find(h => h.crossData.value).number} (cote PMU ${scored.find(h => h.crossData.value).odds} > cote juste ${scored.find(h => h.crossData.value).odds_fair})` : 'Aucun value bet détecté',
      ticket: buildTicket(scored, betType),
      _meta: { method: 'musique', numReunion: numR, numCourse: numC, hippodrome: courseData.hippodrome, totalRunners: horses.length, oddsAvailable: Object.keys(oddsMap).length > 0, reliability: Math.round(avgReliability*100), fetchedAt: new Date().toISOString() },
    };
    cacheSet(ck, result);
    res.status(200).json(result);
  } catch (err) {
    console.error('[v5 hippique]', err.message);
    res.status(500).json({ error: err.message });
  }
}
