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

/**
 * List the logged-in taxpayer's notices/orders (normalized). Requires a
 * logged-in session (notices are private — the logged-in GSTIN's own).
 * Body: { sessionId, section? } where section = 'both' (default) |
 * 'additional' | 'legacy'. Returns { count, notices, sections }.
 */
router.post('/', handler(async (req) => {
  const sessionId = getSession(req);
  const { section } = req.body;
  return gstPortal.getNotices(sessionId, { section: section || 'both' });
}));

/**
 * Download an ORDER-type notice's PDF as base64. Body: { sessionId, docId,
 * applnId } — take docId/applnId from an order-type notice's `refs` in the
 * GET /notices response. Returns { mimeType, size, base64 }.
 * (Case-type notices open a multi-document case folder — different flow, TBD.)
 */
router.post('/download', handler(async (req) => {
  const sessionId = getSession(req);
  const { docId, applnId } = req.body;
  if (!docId || !applnId) throw { status: 400, message: 'docId and applnId are required (from an order-type notice\'s refs)' };
  return gstPortal.downloadOrderNotice(sessionId, { docId, applnId });
}));

/**
 * List the documents inside a CASE-type notice's case folder.
 * Body: { sessionId, caseId, arn, caseTypeCd } — take these from a case-type
 * notice's `refs` (refs.caseId, arn, refs.caseTypeCd) in GET /notices.
 * Returns { count, documents: [{ docName, docId, contentType, docType, folder, refId }] }.
 * Use a document's `docName` with POST /notices/case/download to fetch it.
 */
router.post('/case/documents', handler(async (req) => {
  const sessionId = getSession(req);
  const { caseId, arn, caseTypeCd } = req.body;
  if (!caseId || !arn || !caseTypeCd) throw { status: 400, message: 'caseId, arn and caseTypeCd are required (from a case-type notice: refs.caseId, arn, refs.caseTypeCd)' };
  return gstPortal.getCaseDocuments(sessionId, { caseId, arn, caseTypeCd });
}));

/**
 * Download one document from a case folder as base64.
 * Body: { sessionId, id, docName, folder? } — `id` is the case-type notice
 * id, `docName` and `folder` come from a document in the POST
 * /notices/case/documents response (`folder` lets the download jump straight
 * to the right case-folder tab instead of trying each one in turn).
 */
router.post('/case/download', handler(async (req) => {
  const sessionId = getSession(req);
  const { id, docName, folder } = req.body;
  if (!id || !docName) throw { status: 400, message: 'id (the notice id) and docName are required (docName from GET /notices/case/documents)' };
  return gstPortal.downloadCaseDocument(sessionId, { id, docName, folder });
}));

module.exports = router;
