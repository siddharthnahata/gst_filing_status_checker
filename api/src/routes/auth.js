const { Router } = require('express');
const sessionManager = require('../services/session-manager');
const gstPortal = require('../services/gst-portal');

const router = Router();
const destroySessionQuietly = async (sessionId) => {
  if (!sessionId) return;
  await sessionManager.destroySession(sessionId).catch(() => {});
};

router.post('/login', async (req, res) => {
  let sessionId = null;
  try {
    const { username, password } = req.body;
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    sessionId = await sessionManager.createSession();
    sessionManager.setPendingCredentials(sessionId, { username, password });

    const initResult = await gstPortal.initLogin(sessionId);

    if (initResult.hasCaptcha) {
      return res.json({
        sessionId,
        needsCaptcha: true,
        captchaBase64: initResult.captchaBase64,
        message: 'Captcha required. Submit it via POST /auth/captcha',
      });
    }

    const result = await gstPortal.submitLogin(sessionId, { username, password });

    if (result.needsCaptcha) {
      return res.json({
        sessionId,
        needsCaptcha: true,
        captchaBase64: result.captchaBase64,
        errorMessage: result.errorMessage,
        message: 'Captcha appeared. Submit it via POST /auth/captcha',
      });
    }

    sessionManager.clearPendingCredentials(sessionId);
    res.json({ sessionId, ...result });
  } catch (err) {
    await destroySessionQuietly(sessionId);
    res.status(500).json({ error: err.message });
  }
});

router.post('/captcha', async (req, res) => {
  try {
    const { sessionId, username, password, captcha } = req.body;
    if (!sessionId || !captcha) {
      return res.status(400).json({ error: 'sessionId and captcha are required' });
    }

    if ((username && !password) || (!username && password)) {
      return res.status(400).json({ error: 'username and password must be provided together' });
    }

    const session = sessionManager.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Invalid session' });
    }

    if (typeof username === 'string' && typeof password === 'string' && username && password) {
      sessionManager.setPendingCredentials(sessionId, { username, password });
    }

    const pendingCredentials = session.pendingCredentials || {};
    const resolvedUsername = pendingCredentials.username;
    const resolvedPassword = pendingCredentials.password;

    if (!resolvedUsername || !resolvedPassword) {
      return res.status(400).json({ error: 'username and password are required before captcha submission' });
    }

    const result = await gstPortal.submitLogin(sessionId, {
      username: resolvedUsername,
      password: resolvedPassword,
      captcha,
    });

    if (!result.needsCaptcha) {
      sessionManager.clearPendingCredentials(sessionId);
    }

    res.json({ sessionId, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    await sessionManager.destroySession(sessionId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
