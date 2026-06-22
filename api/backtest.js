import { recordPrediction, verifyPrediction, computeCalibration, computeROI, getPredictions } from './_backtest.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // POST : enregistrer ou vérifier un pronostic
  if (req.method === 'POST') {
    const { action, prediction, id, won, predictions } = req.body || {};
    try {
      if (action === 'record' && prediction) {
        recordPrediction(prediction);
        res.status(200).json({ success: true, recorded: prediction.id });
        return;
      }
      if (action === 'verify' && id !== undefined) {
        const ok = verifyPrediction(id, !!won);
        res.status(200).json({ success: ok });
        return;
      }
      // action 'analyze' : le frontend envoie son historique localStorage pour calcul
      if (action === 'analyze' && Array.isArray(predictions)) {
        const cal = computeCalibration(predictions);
        const roi = computeROI(predictions);
        res.status(200).json({ success: true, calibration: cal, roi });
        return;
      }
      res.status(400).json({ error: 'Action invalide.' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  // GET : statistiques globales (en mémoire serveur)
  const preds = getPredictions();
  const cal = computeCalibration(preds);
  const roi = computeROI(preds);
  res.status(200).json({ success: true, total: preds.length, calibration: cal, roi });
}
