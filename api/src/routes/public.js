const { Router } = require('express');
const gstPortal = require('../services/gst-portal');
const sessionManager = require('../services/session-manager');

const router = Router();

const getSession = (req) => {
  const { sessionId } = req.body;
  if (!sessionId) throw { status: 400, message: 'sessionId is required' };
  if (!sessionManager.getSession(sessionId)) {
    throw { status: 404, message: 'Invalid session' };
  }
  return sessionId;
};

const handler = (fn) => async (req, res) => {
  try {
    const result = await fn(req);
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || err });
  }
};

router.post('/taxpayer', handler(async (req) => {
  const sessionId = getSession(req);
  const { gstin } = req.body;
  if (!gstin) throw { status: 400, message: 'gstin is required' };
  return gstPortal.getPublicTaxpayerDetails(sessionId, gstin);
}));

router.post('/financial-years', handler(async (req) => {
  const sessionId = getSession(req);
  const { gstin } = req.body;
  if (!gstin) throw { status: 400, message: 'gstin is required' };
  return gstPortal.getPublicFinancialYears(sessionId, gstin);
}));

router.post('/filing-status', handler(async (req) => {
  const sessionId = getSession(req);
  const { gstin, financialYear, fy } = req.body;
  const finYear = financialYear || fy;
  if (!gstin) throw { status: 400, message: 'gstin is required' };
  if (!finYear) throw { status: 400, message: 'financialYear is required (e.g. "2023-24")' };
  return gstPortal.getPublicFilingStatus(sessionId, gstin, finYear);
}));

router.post('/filing-frequency', handler(async (req) => {
  const sessionId = getSession(req);
  const { gstin, financialYear, fy } = req.body;
  const finYear = financialYear || fy;
  if (!gstin) throw { status: 400, message: 'gstin is required' };
  if (!finYear) throw { status: 400, message: 'financialYear is required (e.g. "2023-24")' };
  return gstPortal.getPublicFilingFrequency(sessionId, gstin, finYear);
}));

module.exports = router;
