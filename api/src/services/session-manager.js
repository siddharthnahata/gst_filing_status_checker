const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { v4: uuidv4 } = require('uuid');

puppeteer.use(StealthPlugin());
const path = require('path');
const fs = require('fs');
const os = require('os');

const DOWNLOADS_DIR = path.join(os.tmpdir(), 'gst-api-downloads');
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const STALE_DOWNLOAD_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

class SessionManager {
  constructor() {
    this.sessions = new Map();
    if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    this._cleanupStaleDownloadDirs();
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions().catch(() => {});
    }, SESSION_CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  async createSession() {
    await this.cleanupExpiredSessions();

    const sessionId = uuidv4();
    const sessionDownloadDir = this._getManagedDownloadDir(sessionId);
    fs.mkdirSync(sessionDownloadDir, { recursive: true });
    const browser = await puppeteer.launch(this._getLaunchOptions());
    await this._setupBrowserDownloadBehavior(browser, sessionDownloadDir);

    const page = (await browser.pages())[0] || await browser.newPage();

    // Build a UA that matches the ACTUAL bundled Chrome version. A stale/spoofed
    // UA (e.g. claiming 124 while running 146) is cross-checked by Akamai against
    // navigator.userAgentData and sec-ch-ua client hints, and mismatch = Access Denied.
    const browserVersion = await browser.version();             // e.g. "HeadlessChrome/146.0.7680.153"
    const fullVersion = browserVersion.replace(/^.*?\//, '');   // "146.0.7680.153"
    const majorVersion = fullVersion.split('.')[0];             // "146"
    const userAgent =
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Chrome/${fullVersion} Safari/537.36`;

    await page.setUserAgent(userAgent, {
      brands: [
        { brand: 'Chromium', version: majorVersion },
        { brand: 'Google Chrome', version: majorVersion },
        { brand: 'Not=A?Brand', version: '99' },
      ],
      fullVersion,
      platform: 'Windows',
      platformVersion: '15.0.0',
      architecture: 'x86',
      model: '',
      mobile: false,
    });

    // set download directory
    const cdp = await this._setupPageDownloadBehavior(page, sessionDownloadDir);

    this.sessions.set(sessionId, {
      browser,
      page,
      cdp,
      loggedIn: false,
      username: null,
      pendingCredentials: null,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      downloadDir: sessionDownloadDir,
    });

    return sessionId;
  }

  /**
   * Re-configure download directory on a new page/tab.
   */
  async setupDownloadForPage(sessionId, page) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try {
      await this._setupBrowserDownloadBehavior(session.browser, session.downloadDir);
      const cdp = await this._setupPageDownloadBehavior(page, session.downloadDir);
      if (cdp) session.cdp = cdp;
      this._touchSession(session);
    } catch (_) {}
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    this._touchSession(session);
    return session;
  }

  setPendingCredentials(sessionId, credentials) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.pendingCredentials = {
      username: credentials.username,
      password: credentials.password,
      storedAt: Date.now(),
    };
    this._touchSession(session);
  }

  clearPendingCredentials(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.pendingCredentials = null;
    this._touchSession(session);
  }

  async destroySession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.browser.close().catch(() => {});
      this.sessions.delete(sessionId);
      this._removeDownloadDir(session.downloadDir);
    }
  }

  async destroyAll() {
    for (const [id] of this.sessions) {
      await this.destroySession(id);
    }
  }

  async cleanupExpiredSessions() {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      const lastSeenAt = session.lastAccessedAt || session.createdAt || now;
      if (now - lastSeenAt > SESSION_IDLE_TIMEOUT_MS) {
        await this.destroySession(sessionId);
      }
    }
  }

  _touchSession(session) {
    session.lastAccessedAt = Date.now();
  }

  _getLaunchOptions() {
    const isWindows = process.platform === 'win32';
    const isLinux = process.platform === 'linux';
    const commonArgs = [
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
    ];
    const launchArgs = isLinux
      ? [
          ...commonArgs,
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          // NOTE: do NOT add --single-process / --no-zygote here. They save a
          // little RAM but break Chrome's download pipeline and the new-tab
          // "View Summary" flow, so PDF downloads silently time out on the box.
          // The service is MemoryMax-capped, so multi-process Chrome is fine.
        ]
      : commonArgs;

    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
    const launchOptions = {
      headless: this._getHeadlessMode(isWindows),
      defaultViewport: null,
      args: launchArgs,
    };

    if (executablePath) launchOptions.executablePath = executablePath;
    return launchOptions;
  }

  _getHeadlessMode(isWindows) {
    const configured = (process.env.PUPPETEER_HEADLESS || '').trim().toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(configured)) return false;
    if (configured === 'new') return 'new';
    if (['1', 'true', 'yes', 'on'].includes(configured)) return true;
    return isWindows ? false : 'new';
  }

  async _setupBrowserDownloadBehavior(browser, downloadDir) {
    try {
      const context = browser.defaultBrowserContext?.();
      if (context?.setDownloadBehavior) {
        await context.setDownloadBehavior({
          policy: 'allow',
          downloadPath: downloadDir,
        });
      }
    } catch (_) {}
  }

  async _setupPageDownloadBehavior(page, downloadDir) {
    const cdp = await page.createCDPSession();
    try {
      await cdp.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir,
      });
      return cdp;
    } catch (_) {
      await cdp.detach().catch(() => {});
      return null;
    }
  }

  _getManagedDownloadDir(sessionId) {
    return path.join(DOWNLOADS_DIR, sessionId);
  }

  _removeDownloadDir(downloadDir) {
    if (!downloadDir) return;
    const resolvedBase = path.resolve(DOWNLOADS_DIR);
    const resolvedTarget = path.resolve(downloadDir);
    if (resolvedTarget === resolvedBase || !resolvedTarget.startsWith(`${resolvedBase}${path.sep}`)) return;
    fs.rmSync(resolvedTarget, { recursive: true, force: true });
  }

  _cleanupStaleDownloadDirs() {
    if (!fs.existsSync(DOWNLOADS_DIR)) return;

    const cutoff = Date.now() - STALE_DOWNLOAD_DIR_MAX_AGE_MS;
    for (const entry of fs.readdirSync(DOWNLOADS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const fullPath = path.join(DOWNLOADS_DIR, entry.name);
      try {
        const stats = fs.statSync(fullPath);
        if (stats.mtimeMs < cutoff) {
          this._removeDownloadDir(fullPath);
        }
      } catch (_) {}
    }
  }
}

module.exports = new SessionManager();
