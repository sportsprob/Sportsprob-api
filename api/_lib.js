// ════════════════════════════════════════════════════════════════════
// Utilitaires partagés — fiabilité et robustesse
// ════════════════════════════════════════════════════════════════════

// ── CACHE EN MÉMOIRE (simple, par instance Vercel) ────────────────────
// Note: sur Vercel serverless, le cache persiste tant que l'instance est "chaude"
// (quelques minutes). C'est suffisant pour éviter les doubles appels rapprochés.
const _cache = new Map();
const CACHE_TTL_MS = 8 * 60 * 1000; // 8 minutes

export function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return entry.value;
}

export function cacheSet(key, value) {
  // Limite la taille du cache pour éviter les fuites mémoire
  if (_cache.size > 100) {
    const firstKey = _cache.keys().next().value;
    _cache.delete(firstKey);
  }
  _cache.set(key, { value, ts: Date.now() });
}

export function cacheAge(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  return Math.round((Date.now() - entry.ts) / 1000); // secondes
}

// ── RETRY AUTOMATIQUE avec backoff ────────────────────────────────────
export async function withRetry(fn, { retries = 2, delayMs = 600, label = 'opération' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Ne pas réessayer sur les erreurs définitives (4xx sauf 429)
      const msg = err.message || '';
      const is4xx = /HTTP 4[0-9][0-9]/.test(msg) && !/HTTP 429/.test(msg);
      if (is4xx || attempt === retries) break;
      await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

// ── FETCH avec timeout ────────────────────────────────────────────────
export async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Délai dépassé — le serveur met trop de temps à répondre.');
    throw err;
  } finally {
    clearTimeout(id);
  }
}

// ── EXTRACTION + VALIDATION JSON Gemini ───────────────────────────────
export function extractJSON(text) {
  if (!text || typeof text !== 'string') throw new Error('Réponse IA vide ou invalide.');
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const s = cleaned.indexOf('{');
  const e = cleaned.lastIndexOf('}');
  if (s === -1 || e === -1 || e <= s) throw new Error('Format de réponse IA invalide (pas de JSON détecté).');
  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(s, e + 1));
  } catch {
    // Tentative de réparation : enlever les virgules traînantes
    const repaired = cleaned.slice(s, e + 1).replace(/,(\s*[}\]])/g, '$1');
    try { parsed = JSON.parse(repaired); }
    catch { throw new Error('Impossible de lire la réponse de l\'IA (JSON malformé).'); }
  }
  return parsed;
}

// ── NORMALISATION des probabilités football (somme = 1.0) ─────────────
export function normalizeFootballProbs(analysis) {
  if (!analysis?.probabilities) return analysis;
  const opts = Object.values(analysis.probabilities).filter(o => o && typeof o.probability === 'number');
  const sum = opts.reduce((acc, o) => acc + (o.probability || 0), 0);
  if (sum > 0 && Math.abs(sum - 1) > 0.02) {
    // Renormalise pour que la somme fasse exactement 1.0
    opts.forEach(o => {
      o.probability = o.probability / sum;
      o.odds_fair = o.probability > 0 ? Math.round((1 / o.probability) * 100) / 100 : 0;
    });
  } else {
    // Recalcule les cotes au cas où elles seraient incohérentes
    opts.forEach(o => {
      if (o.probability > 0) o.odds_fair = Math.round((1 / o.probability) * 100) / 100;
    });
  }
  return analysis;
}

// ── NORMALISATION des probabilités hippiques (somme = 1.0) ────────────
export function normalizeHorseProbs(analysis) {
  if (!Array.isArray(analysis?.horses)) return analysis;
  const horses = analysis.horses.filter(h => h && typeof h.probability === 'number');
  const sum = horses.reduce((acc, h) => acc + (h.probability || 0), 0);
  if (sum > 0 && Math.abs(sum - 1) > 0.02) {
    horses.forEach(h => {
      h.probability = h.probability / sum;
      h.odds_fair = h.probability > 0 ? Math.round((1 / h.probability) * 100) / 100 : 0;
    });
  }
  // Recalcule is_value : cote PMU > cote juste = value positive
  horses.forEach(h => {
    if (h.odds_market && h.odds_fair) {
      h.is_value = h.odds_market > h.odds_fair * 1.05; // 5% de marge
    }
  });
  return analysis;
}

// ── VALIDATION structure football ─────────────────────────────────────
export function validateFootball(analysis) {
  const errors = [];
  if (!analysis.probabilities) errors.push('probabilités manquantes');
  if (!analysis.confidence) analysis.confidence = 'moyenne';
  if (!Array.isArray(analysis.key_factors)) analysis.key_factors = [];
  if (!analysis.recommendation) analysis.recommendation = 'Analyse disponible ci-dessus.';
  // Le ticket est optionnel mais on s'assure qu'il est cohérent s'il existe
  if (analysis.ticket && typeof analysis.ticket !== 'object') analysis.ticket = null;
  if (errors.length) throw new Error('Réponse IA incomplète : ' + errors.join(', '));
  return analysis;
}

// ── VALIDATION structure hippique ─────────────────────────────────────
export function validateHorse(analysis) {
  if (!Array.isArray(analysis.horses) || analysis.horses.length === 0) {
    throw new Error('Réponse IA incomplète : aucun cheval analysé.');
  }
  if (!analysis.confidence) analysis.confidence = 'moyenne';
  if (!Array.isArray(analysis.key_factors)) analysis.key_factors = [];
  if (!Array.isArray(analysis.top_selection)) analysis.top_selection = [];
  if (!analysis.recommendation) analysis.recommendation = 'Analyse disponible ci-dessus.';
  if (analysis.ticket && typeof analysis.ticket !== 'object') analysis.ticket = null;
  return analysis;
}

// ── APPEL GEMINI centralisé (avec retry + validation) ─────────────────
export async function callGemini(prompt, maxTokens = 3000) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Variable GEMINI_API_KEY manquante sur Vercel.');

  const doCall = async () => {
    const res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
        }),
      },
      15000
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const code = res.status;
      if (code === 429) throw new Error('Quota Gemini épuisé (1500/jour). Réessayez après minuit.');
      if (code === 400 && /API key/i.test(err?.error?.message || '')) throw new Error('Clé Gemini invalide. Vérifiez GEMINI_API_KEY sur Vercel.');
      throw new Error('Gemini: ' + (err?.error?.message || `HTTP ${code}`));
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini: réponse vide.');
    return text;
  };

  const text = await withRetry(doCall, { retries: 2, delayMs: 800, label: 'Gemini' });
  return extractJSON(text);
}
