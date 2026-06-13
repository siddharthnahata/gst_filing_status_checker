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

router.post('/gstr1/download-pdf', handler(async (req) => {
  const sessionId = getSession(req);
  const { financialYear, returnPeriod, filingPeriod, month, returnType } = req.body;
  if (!financialYear || !(month || returnPeriod)) {
    throw { status: 400, message: 'financialYear and month or returnPeriod are required' };
  }
  return gstPortal.downloadGstr1Pdf(sessionId, {
    financialYear,
    returnPeriod,
    filingPeriod,
    month,
    returnType,
  });
}));

router.post('/gstr3b/download-pdf', handler(async (req) => {
  const sessionId = getSession(req);
  const { financialYear, returnPeriod, filingPeriod, month, returnType } = req.body;
  if (!financialYear || !(month || returnPeriod)) {
    throw { status: 400, message: 'financialYear and month or returnPeriod are required' };
  }
  return gstPortal.downloadGstr3bPdf(sessionId, {
    financialYear,
    returnPeriod,
    filingPeriod,
    month,
    returnType,
  });
}));

module.exports = router;
