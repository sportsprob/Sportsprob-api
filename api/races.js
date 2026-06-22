import { cacheGet, cacheSet, withRetry, fetchWithTimeout } from './_lib.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function toYMD(dateStr) {
  if (!dateStr) {
    const n = new Date();
    return [n.getFullYear(), String(n.getMonth()+1).padStart(2,'0'), String(n.getDate()).padStart(2,'0')];
  }
  if (dateStr.includes('/')) { const [d,m,y] = dateStr.split('/'); return [y, m.padStart(2,'0'), d.padStart(2,'0')]; }
  return dateStr.split('-');
}

const PMU_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
  'Accept-Language': 'fr-FR,fr;q=0.9',
};

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const dateStr = (req.query?.date || '').trim();
  const sportFilter = (req.query?.sport || '').trim(); // 'trot' | 'galop' | ''
  const [y, m, d] = toYMD(dateStr);

  const cacheKey = `races:${y}${m}${d}:${sportFilter}`;
  const cached = cacheGet(cacheKey);
  if (cached) { res.status(200).json({ races: cached, date: `${d}/${m}/${y}`, cached: true }); return; }

  try {
    const data = await withRetry(async () => {
      const r = await fetchWithTimeout(`https://online.pmu.fr/services/rest/program/${y}/${m}/${d}`, { headers: PMU_HEADERS }, 10000);
      if (r.status === 403) throw new Error('PMU bloque temporairement. Réessayez plus tard.');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }, { retries: 2, delayMs: 800 });

    const reunions = data?.programme?.reunions || data?.reunions || [];
    const races = [];
    for (const reunion of reunions) {
      const hippo = reunion.hippodrome?.libelleLong || reunion.hippodrome?.libelleAbrege || '';
      for (const course of (reunion.courses || reunion.listCourses || [])) {
        const disc = (course.discipline || '').toUpperCase();
        const isTrot = disc.includes('TROT');
        const isGalop = disc.includes('PLAT') || disc.includes('HAIE') || disc.includes('STEEPLE') || disc.includes('OBSTACLE');
        // Filtre par sport si demandé
        if (sportFilter === 'trot' && !isTrot) continue;
        if (sportFilter === 'galop' && !isGalop) continue;

        races.push({
          name: course.libelleLong || course.libelleCourt,
          reunion: reunion.numOfficiel,
          course: course.numOrdre,
          hippodrome: hippo,
          distance: course.distance,
          discipline: course.discipline,
          isQuinte: course.categorieParticularite === 'QUINTE_PLUS' || (course.libelleLong || '').toLowerCase().includes('quinté'),
          heure: course.heureDepart ? new Date(course.heureDepart).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : null,
        });
      }
    }

    // Quintés en premier, puis par réunion/course
    races.sort((a, b) => (b.isQuinte ? 1 : 0) - (a.isQuinte ? 1 : 0));

    cacheSet(cacheKey, races);
    res.status(200).json({ races, date: `${d}/${m}/${y}` });
  } catch (err) {
    res.status(200).json({ races: [], date: `${d}/${m}/${y}`, error: err.message });
  }
}
