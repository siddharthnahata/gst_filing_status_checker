const sessionManager = require('./session-manager');
const captchaStore = require('./captcha-store');
const rateLimiter = require('./rate-limiter');
const fs = require('fs');
const path = require('path');
const os = require('os');

const GST_LOGIN_URL = 'https://services.gst.gov.in/services/login';
const DOWNLOAD_TIMEOUT_MS = Number.parseInt(process.env.GST_DOWNLOAD_TIMEOUT_MS || '', 10)
  || (process.platform === 'linux' ? 60000 : 30000);

// Filed returns are immutable once downloaded — cache the PDF by GSTIN +
// return type + period so re-requesting the same one skips Puppeteer
// entirely. Lives in Electron's userData (passed down via PDF_CACHE_DIR) so
// it survives app updates, unlike the bundled resourcesPath the API code
// itself runs from; falls back to a tmpdir when run standalone.
const PDF_CACHE_DIR = process.env.PDF_CACHE_DIR || path.join(os.tmpdir(), 'gst-pdf-cache');

// Category tabs on a litserv case-folder page (client-side tabs, same URL).
// Only one renders its documents by default, so a target document may live
// under a tab we haven't opened yet — cycle through these when not found.
const CASE_FOLDER_TABS = [
  'NOTICES', 'REPLIES', 'ORDERS', 'APPLICATIONS', 'RECTIFICATION',
  'ADDITIONAL DOCUMENT', 'WITHDRAWAL APPLICATION', 'REMAND DETAILS',
  'UPLOAD OFFLINE APL-04 ORDERS',
];
class GSTPortal {

  // ─── LOGIN FLOW ───────────────────────────────────────────────

  async initLogin(sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error('Invalid session');

    const { page } = session;

    await page.goto(GST_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    const captchaState = await this._checkCaptcha(page);
    // remember the image shown so we can label it if this captcha solves login
    session.lastCaptchaBase64 = captchaState.captchaBase64 || null;
    return { hasCaptcha: captchaState.hasCaptcha, captchaBase64: captchaState.captchaBase64 };
  }

  async submitLogin(sessionId, { username, password, captcha }) {
    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error('Invalid session');
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      throw new Error('username and password are required');
    }

    const { page } = session;
    const previousUrl = page.url();

    await page.waitForSelector('#username', { timeout: 10000 });
    await page.$eval('#username', el => (el.value = ''));
    await page.type('#username', username, { delay: 30 });

    await page.$eval('#user_pass', el => (el.value = ''));
    await page.type('#user_pass', password, { delay: 30 });

    if (captcha) {
      const captchaInput = await page.$('#captcha');
      if (captchaInput) {
        await page.$eval('#captcha', el => (el.value = ''));
        await page.type('#captcha', captcha, { delay: 30 });
      }
    }

    const navigationPromise = page.waitForNavigation({
      waitUntil: 'domcontentloaded',
      timeout: 5000,
    }).catch(() => null);

    await page.click('button[type="submit"]');

    await Promise.race([
      navigationPromise,
      this._waitForLoginResult(page, previousUrl, 6000),
    ]);

    await this._waitForLoginResult(page, previousUrl, 2000);

    const currentUrl = page.url();
    const isLoggedIn = currentUrl.includes('fowelcome') || currentUrl.includes('dashboard');

    let errorMessage = null;
    if (!isLoggedIn) {
      errorMessage = await this._getErrorMessage(page);
      const captchaState = await this._checkCaptcha(page);
      if (captchaState.hasCaptcha) {
        // a fresh captcha is shown after a failed attempt — track this one
        session.lastCaptchaBase64 = captchaState.captchaBase64 || null;
        return { loggedIn: false, needsCaptcha: true, captchaBase64: captchaState.captchaBase64, errorMessage, currentUrl };
      }
    }

    if (isLoggedIn) {
      session.loggedIn = true;
      session.username = username;
      session.pendingCredentials = null;

      // dismiss popup
      await this._dismissPopup(page);

      // extract user info
      session.userInfo = await page.evaluate(() => {
        return {
          gstin: document.body.innerText.match(/\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d]{2}/)?.[0] || null,
          name: document.body.innerText.match(/Welcome\s+(.+?)(?:\s+to)/)?.[1]?.trim() || null,
        };
      });

      // Save the solved captcha (image + the text that worked) as labelled
      // training data. Only on success, so the label is known-correct.
      if (captcha && session.lastCaptchaBase64) {
        captchaStore.saveSolvedCaptcha({
          username,
          gstin: session.userInfo?.gstin || null,
          captchaText: captcha,
          captchaBase64: session.lastCaptchaBase64,
        });
        session.lastCaptchaBase64 = null;
      }

      // navigate to returns dashboard via click (not URL)
      await this._navigateToReturnsDashboard(session);
    } else {
      session.pendingCredentials = null;
    }

    return { loggedIn: isLoggedIn, errorMessage, currentUrl, userInfo: session.userInfo };
  }

  // ─── RETURNS APIs (via browser fetch) ─────────────────────────

  /**
   * Navigate to "View Filed Returns" page via: Services → Returns → View Filed Returns.
   * Then fill in the form: Financial Year, Return Filing Period/Month, Return Type.
   * Returns the active page after navigation.
   */
  async _navigateToViewFiledReturns(session, options) {
    const page = session.page;
    const selection = this._normalizeReturnSelection(options);
    let activePage = await this._openViewFiledReturns(session, page);
    await this._settlePortalPage(activePage, { timeout: 1200, fallbackMs: 80 });

    // Step 4: Fill in Financial Year dropdown
    if (selection.financialYear) {
      await activePage.waitForSelector('select', { timeout: 10000 }).catch(() => {});
      await this._selectViewFiledReturnsOption(activePage, selection.financialYear, {
        preferHints: ['financial', 'fy', 'year'],
      });
      await this._settlePortalPage(activePage, { timeout: 1200, fallbackMs: 80 });
    }

    // Step 5: Fill in Return Filing Period (Monthly / Quarterly) if present
    if (selection.filingPeriod) {
      await this._selectViewFiledReturnsOption(activePage, selection.filingPeriod, {
        preferHints: ['filing', 'period', 'tax', 'quarter', 'monthly'],
        avoidHints: ['return type', 'month', 'financial', 'fy', 'year'],
      });
      await this._settlePortalPage(activePage, { timeout: 1200, fallbackMs: 80 });
    }

    // Step 6: Fill in Month / Tax Period
    if (selection.month) {
      await this._selectViewFiledReturnsOption(activePage, selection.month, {
        preferHints: ['month', 'tax period'],
        avoidHints: ['return type', 'financial', 'fy', 'year'],
      });
      await this._settlePortalPage(activePage, { timeout: 1200, fallbackMs: 80 });
    } else if (selection.returnPeriod && !selection.filingPeriod) {
      await this._selectViewFiledReturnsOption(activePage, selection.returnPeriod, {
        preferHints: ['period', 'month', 'tax'],
        avoidHints: ['return type', 'financial', 'fy', 'year'],
      });
      await this._settlePortalPage(activePage, { timeout: 1200, fallbackMs: 80 });
    }

    // Step 7: Select Return Type (GSTR-1, GSTR-3B, etc.)
    if (selection.returnType) {
      await this._selectViewFiledReturnsOption(activePage, selection.returnType, {
        preferHints: ['return type', 'return', 'form'],
        avoidHints: ['financial', 'fy', 'year', 'month'],
      });
      await this._settlePortalPage(activePage, { timeout: 1200, fallbackMs: 80 });
    }

    // Step 8: Click SEARCH button
    await activePage.evaluate(() => {
      const btns = document.querySelectorAll('button, input[type="submit"], input[type="button"]');
      for (const btn of btns) {
        if (btn.textContent?.toUpperCase().includes('SEARCH') || btn.value?.toUpperCase().includes('SEARCH')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    await this._settlePortalPage(activePage, { timeout: 1200, fallbackMs: 80 });

    await activePage.waitForFunction(() => {
      const bodyText = document.body.innerText.toUpperCase();
      if (bodyText.includes('NO RECORD FOUND') || bodyText.includes('NOT FILED')) return true;
      return Array.from(document.querySelectorAll('button, a, input[type="button"]')).some((el) => {
        const text = (el.textContent || el.value || '').trim().toUpperCase();
        return text === 'VIEW' || text.startsWith('VIEW ');
      });
    }, { timeout: 10000, polling: 250 }).catch(() => {});

    const viewClick = await this._clickFiledReturnViewRow(activePage, selection);

    if (!viewClick) {
      return activePage;
    }

    await this._waitForPageSwitchOrUrlChange(session, activePage, activePage.url(), {
      targetUrlPart: '/returns/auth/',
      timeout: 8000,
    });
    activePage = await this._getLatestActivePage(session, activePage);
    await this._settlePortalPage(activePage, { timeout: 1200, fallbackMs: 80 });

    return activePage;
  }

  // ─── PDF CACHE (filed returns are immutable once downloaded) ─────

  _pdfCacheKey(returnTypeTag, gstin, period) {
    return `${returnTypeTag}_${gstin}_${period}.pdf`;
  }

  _readCachedPdf(cacheKey) {
    try {
      const filePath = path.join(PDF_CACHE_DIR, cacheKey);
      if (!fs.existsSync(filePath)) return null;
      const buffer = fs.readFileSync(filePath);
      // Guard against a corrupted/partial cache write (rare, but silently
      // serving a broken file would be worse than just re-downloading).
      if (buffer.length < 5 || buffer.toString('utf8', 0, 5) !== '%PDF-') {
        try { fs.unlinkSync(filePath); } catch (_) {}
        return null;
      }
      return { filename: cacheKey, size: buffer.length, mimeType: 'application/pdf', base64: buffer.toString('base64'), cached: true };
    } catch (_) {
      return null; // best-effort — a bad cache entry just falls through to a fresh download
    }
  }

  _writeCachedPdf(cacheKey, buffer) {
    try {
      fs.mkdirSync(PDF_CACHE_DIR, { recursive: true });
      fs.writeFileSync(path.join(PDF_CACHE_DIR, cacheKey), buffer);
    } catch (_) { /* best-effort — cache write failure must not fail the download */ }
  }

  // Generic byte cache for notice/case documents — unlike returns these
  // aren't guaranteed to be PDFs (case docs can be pdf/zip/jpg/png), so no
  // magic-byte format check, just a non-empty-file sanity guard.
  _sanitizeCacheSegment(s) {
    return String(s || '').replace(/[^A-Za-z0-9.\-]+/g, '_');
  }

  _readCacheBuffer(cacheKey) {
    try {
      const filePath = path.join(PDF_CACHE_DIR, cacheKey);
      if (!fs.existsSync(filePath)) return null;
      const buffer = fs.readFileSync(filePath);
      if (!buffer.length) { try { fs.unlinkSync(filePath); } catch (_) {} return null; }
      return buffer;
    } catch (_) {
      return null;
    }
  }

  _writeCacheBuffer(cacheKey, buffer) {
    try {
      fs.mkdirSync(PDF_CACHE_DIR, { recursive: true });
      fs.writeFileSync(path.join(PDF_CACHE_DIR, cacheKey), buffer);
    } catch (_) { /* best-effort */ }
  }

  /**
   * GSTR-1: Download filed PDF.
   * Uses "View Filed Returns" flow: Services → Returns → View Filed Returns → fill form.
   * Handles both nil (direct download) and non-nil (View Summary → Download PDF).
   */
  async downloadGstr1Pdf(sessionId, options) {
    const session = sessionManager.getSession(sessionId);
    if (!session?.loggedIn) throw new Error('Not logged in');

    const selection = this._normalizeReturnSelection({
      ...options,
      returnType: options.returnType || 'GSTR-1/IFF/GSTR-1A',
    });
    const requestedPeriod = this._periodKeyFromSelection(selection);
    const downloadDir = session.downloadDir;

    const gstin = session.userInfo?.gstin;
    const cacheKey = (gstin && requestedPeriod) ? this._pdfCacheKey('GSTR1', gstin, requestedPeriod) : null;
    if (cacheKey && !options.forceRefresh) {
      const cached = this._readCachedPdf(cacheKey);
      if (cached) return cached;
    }

    // clear existing files
    const existing = fs.readdirSync(downloadDir);
    for (const f of existing) fs.unlinkSync(path.join(downloadDir, f));

    // navigate via Services → Returns → View Filed Returns
    const activePage = await this._navigateToViewFiledReturns(session, {
      financialYear: selection.financialYear,
      returnPeriod: selection.returnPeriod,
      filingPeriod: selection.filingPeriod,
      month: selection.month,
      returnType: selection.returnType,
    });

    // setup download on active page
    await sessionManager.setupDownloadForPage(sessionId, activePage);

    // Now check what's on the page:
    // - Nil filed: may have "DOWNLOAD FILED (PDF)" or "DOWNLOAD" directly
    // - Non-nil filed: has "VIEW SUMMARY" button → click it first, then download
    // - Not filed: no download option
    // Poll (don't check once) — the return page renders its buttons after the
    // header, and a single check can race ahead of them on the slower box.
    const pageState = await this._resolveGstr1PageState(activePage);

    if (pageState.notFiled) {
      return { error: 'Return not filed for this period', status: 'NOT_FILED' };
    }

    // Case 1: Direct "DOWNLOAD FILED (PDF)" button (nil return)
    if (pageState.hasDownloadFiled) {
      const clicked = await this._clickGstr1PdfButton(activePage, { allowGenericDownload: false });
      if (!clicked) {
        await this._dumpDiag(session, activePage, 'gstr1-no-direct-pdf-button');
        return { error: 'Could not find direct GSTR-1 PDF button on the filed return page', pageButtons: pageState.controls };
      }
    }
    // Case 2: Non-nil return — click "VIEW SUMMARY" first
    else if (pageState.hasViewSummary) {
      // click View Summary — strictly match only this text
      const clickedSummary = await this._clickViewSummaryButton(activePage);
      if (!clickedSummary) {
        await this._dumpDiag(session, activePage, 'gstr1-no-view-summary-button');
        return { error: 'Could not find VIEW SUMMARY button on GSTR-1 page', pageButtons: pageState.controls };
      }
      await this._waitForPageSwitchOrUrlChange(session, activePage, activePage.url(), {
        targetUrlPart: '/returns/auth/gstr1',
        timeout: 8000,
      });
      await this._settlePortalPage(activePage, { timeout: 1200, fallbackMs: 80 });

      const summaryPage = await this._getLatestActivePage(session, activePage);
      await sessionManager.setupDownloadForPage(sessionId, summaryPage);
      await this._waitForGstr1SummaryPdf(summaryPage);
      await this._dumpDiag(session, summaryPage, 'gstr1-summary-before-download');

      // now click "DOWNLOAD PDF" or "DOWNLOAD" on the summary page
      const dlClicked = await this._clickGstr1PdfButton(summaryPage, { allowGenericDownload: true });

      if (!dlClicked) {
        const summaryState = await this._getGstr1PageState(summaryPage);
        await this._dumpDiag(session, summaryPage, 'gstr1-no-download-button');
        return { error: 'Could not find DOWNLOAD button on summary page', pageButtons: summaryState.controls };
      }
    }
    // Case 3: Generic download button
    else if (pageState.hasDownload) {
      const clicked = await this._clickGstr1PdfButton(activePage, { allowGenericDownload: true });
      if (!clicked) {
        await this._dumpDiag(session, activePage, 'gstr1-no-generic-download-button');
        return { error: 'Could not find a download button on the GSTR-1 page', pageButtons: pageState.controls };
      }
    } else {
      await this._dumpDiag(session, activePage, 'gstr1-no-download-option');
      return { error: 'No download option found on page', pageButtons: pageState.controls };
    }

    // wait for file to appear
    const file = await this._waitForDownload(downloadDir, DOWNLOAD_TIMEOUT_MS);
    if (!file) {
      await this._dumpDiag(session, await this._getLatestActivePage(session, activePage), 'gstr1-download-timeout');
      return { error: 'Download timed out' };
    }

    const filePath = path.join(downloadDir, file);

    // Guard: the portal silently falls back to the latest filed month when the
    // requested period isn't filed / not yet fileable (e.g. the current month).
    // The portal-generated filename encodes the real period — if it doesn't
    // match what we asked for, treat it as "not filed" rather than returning
    // someone the wrong return.
    const servedPeriod = this._periodKeyFromFilename(file);
    if (requestedPeriod && servedPeriod && servedPeriod !== requestedPeriod) {
      fs.rmSync(filePath, { force: true });
      return {
        error: `GSTR-1 not filed for the requested period (portal served ${servedPeriod}, requested ${requestedPeriod}).`,
        status: 'NOT_FILED',
        requestedPeriod,
        servedPeriod,
      };
    }

    const buffer = fs.readFileSync(filePath);
    fs.rmSync(filePath, { force: true });
    // Only cache when the portal-served period is positively confirmed to
    // match what was requested — if the filename didn't carry a parseable
    // period, we can't prove this result is correct, so don't persist it.
    if (cacheKey && servedPeriod === requestedPeriod) this._writeCachedPdf(cacheKey, buffer);

    return {
      filename: file,
      size: buffer.length,
      mimeType: 'application/pdf',
      base64: buffer.toString('base64'),
    };
  }

  /**
   * GSTR-3B: Download filed PDF.
   * Uses "View Filed Returns" flow and prefers the filed return PDF button.
   */
  async downloadGstr3bPdf(sessionId, options) {
    const session = sessionManager.getSession(sessionId);
    if (!session?.loggedIn) throw new Error('Not logged in');

    const selection = this._normalizeReturnSelection({
      ...options,
      returnType: options.returnType || 'GSTR-3B',
    });
    const requestedPeriod = this._periodKeyFromSelection(selection);
    const downloadDir = session.downloadDir;

    const gstin = session.userInfo?.gstin;
    const cacheKey = (gstin && requestedPeriod) ? this._pdfCacheKey('GSTR3B', gstin, requestedPeriod) : null;
    if (cacheKey && !options.forceRefresh) {
      const cached = this._readCachedPdf(cacheKey);
      if (cached) return cached;
    }

    const existing = fs.readdirSync(downloadDir);
    for (const f of existing) fs.unlinkSync(path.join(downloadDir, f));

    let activePage = await this._navigateToViewFiledReturns(session, selection);
    await sessionManager.setupDownloadForPage(sessionId, activePage);
    await this._settlePortalPage(activePage, { timeout: 1200, fallbackMs: 80 });

    let pageState = await this._getGstr3bPageState(activePage);

    if (pageState.hasSummaryPopup) {
      await this._dismissGstr3bSummaryPopup(activePage);
      await this._settlePortalPage(activePage, { timeout: 1500, fallbackMs: 100 });
      activePage = await this._getLatestActivePage(session, activePage);
      await sessionManager.setupDownloadForPage(sessionId, activePage);
      pageState = await this._getGstr3bPageState(activePage);
    }

    if (pageState.notFiled) {
      return { error: 'Return not filed for this period', status: 'NOT_FILED' };
    }

    let clickResult = await this._clickGstr3bPdfButton(activePage, {
      allowGenericDownload: true,
      allowSystemGenerated: false,
    });

    if (!clickResult) {
      const refreshedState = await this._getGstr3bPageState(activePage);
      if (refreshedState.hasSystemGenerated) {
        clickResult = await this._clickGstr3bPdfButton(activePage, {
          allowGenericDownload: false,
          allowSystemGenerated: true,
        });
      }

      if (!clickResult) {
        await this._dumpDiag(session, activePage, 'gstr3b-no-download-button');
        return {
          error: 'Could not find GSTR-3B PDF button on the filed return page',
          pageButtons: refreshedState.controls,
        };
      }
    }

    const file = await this._waitForDownload(downloadDir, DOWNLOAD_TIMEOUT_MS);
    if (!file) {
      await this._dumpDiag(session, await this._getLatestActivePage(session, activePage), 'gstr3b-download-timeout');
      return { error: 'Download timed out' };
    }

    const filePath = path.join(downloadDir, file);

    // Same period-mismatch guard as GSTR-1: never return the latest filed
    // month's PDF when the requested period isn't actually filed.
    const servedPeriod = this._periodKeyFromFilename(file);
    if (requestedPeriod && servedPeriod && servedPeriod !== requestedPeriod) {
      fs.rmSync(filePath, { force: true });
      return {
        error: `GSTR-3B not filed for the requested period (portal served ${servedPeriod}, requested ${requestedPeriod}).`,
        status: 'NOT_FILED',
        requestedPeriod,
        servedPeriod,
      };
    }

    const buffer = fs.readFileSync(filePath);
    fs.rmSync(filePath, { force: true });
    // Only cache when the portal-served period is positively confirmed to
    // match what was requested — see the same guard in downloadGstr1Pdf.
    if (cacheKey && servedPeriod === requestedPeriod) this._writeCachedPdf(cacheKey, buffer);

    return {
      filename: file,
      size: buffer.length,
      mimeType: 'application/pdf',
      base64: buffer.toString('base64'),
      downloadSource: clickResult.source,
    };
  }

  // ─── PUBLIC TAXPAYER APIs (post-login, no captcha) ───────────
  // These endpoints let a logged-in session query filing info for ANY GSTIN.

  /**
   * Get taxpayer details (legal name, trade name, address, jurisdiction, etc.)
   * for any GSTIN.
   */
  async getPublicTaxpayerDetails(sessionId, gstin) {
    if (!gstin) throw new Error('gstin is required');
    return this.callPortalApi(
      sessionId,
      'https://services.gst.gov.in/services/auth/api/search/tp',
      'POST',
      { gstin },
    );
  }

  /**
   * Get the list of financial years available for a GSTIN.
   */
  async getPublicFinancialYears(sessionId, gstin) {
    if (!gstin) throw new Error('gstin is required');
    const url = `https://services.gst.gov.in/services/auth/api/dropdownfinyear?gstin=${encodeURIComponent(gstin)}`;
    return this.callPortalApi(sessionId, url, 'GET');
  }

  /**
   * Get the return filing table (per-period, per-return-type filed/not-filed
   * status with filing date + ARN) for ANY GSTIN for a given financial year.
   * This is the "Show Filing Table" data from Search Taxpayer.
   *
   * Endpoint: POST /services/api/search/taxpayerReturnDetails — this is the
   * SAME-ORIGIN "prelogin" variant the portal's own searchtpCtrl uses (the
   * post-login variant lives on publicservices.gst.gov.in, which is CORS-locked
   * to the Angular app and unreachable by raw fetch). A logged-in session can
   * call the same-origin variant directly; no captcha is enforced on it.
   *
   * `fy` is a single 4-digit FY start year, e.g. "2023-24" -> "2023". Accepts
   * "2023-24", "2023", or 2023.
   *
   * Response shape:
   *   { filingStatus: [ [ { fy, taxp, mof, dof, rtntype, arn, status }, ... ] ] }
   * where rtntype = GSTR1/GSTR3B/..., taxp = period (month/quarter),
   * dof = date of filing, status = "Filed" / not.
   */
  async getPublicFilingStatus(sessionId, gstin, fy) {
    if (!gstin) throw new Error('gstin is required');
    if (!fy && fy !== 0) throw new Error('fy is required (e.g. "2023-24")');
    const year = this._toFyStartYear(fy);
    if (!year) throw new Error(`Could not parse a financial year from "${fy}" (expected e.g. "2023-24")`);
    // High-volume batch path (Tab 1 scans hundreds of GSTINs) — bypasses the
    // shared rate limiter's per-call gap; pacing for this path is handled by
    // the client's own periodic pause instead (see renderer.js runBatch).
    return this._callPortalApi(
      sessionId,
      'https://services.gst.gov.in/services/api/search/taxpayerReturnDetails',
      'POST',
      { gstin, fy: year },
    );
  }

  /**
   * Get the return filing frequency/preference (per-quarter Monthly/Quarterly)
   * for a GSTIN for a given financial year. Same-origin, verified 200.
   * `fy` accepts "2023-24", "2023", or 2023 (uses the 4-digit start year).
   */
  async getPublicFilingFrequency(sessionId, gstin, fy) {
    if (!gstin) throw new Error('gstin is required');
    const year = this._toFyStartYear(fy);
    if (!year) throw new Error(`Could not parse a financial year from "${fy}" (expected e.g. "2023-24")`);
    const url = `https://services.gst.gov.in/services/auth/api/search/taxpayerProfileDetails`
      + `?fy=${year}&gstin=${encodeURIComponent(gstin)}`;
    return this.callPortalApi(sessionId, url, 'GET');
  }

  /** Normalize a financial-year input to its 4-digit start year. */
  _toFyStartYear(fy) {
    const m = String(fy).match(/(\d{4})/);
    return m ? m[1] : null;
  }

  /**
   * Build the canonical "MMYYYY" period key for a selection, used to verify the
   * portal actually served the period we asked for. Returns null when it can't
   * be determined confidently (e.g. quarterly selections) so callers can skip
   * the strict check rather than false-positive.
   */
  _periodKeyFromSelection(selection = {}) {
    const rp = typeof selection.returnPeriod === 'string' ? selection.returnPeriod.trim() : '';
    if (/^\d{6}$/.test(rp)) return rp; // already MMYYYY

    const months = {
      january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
      july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    };
    const monthNum = months[(selection.month || '').toString().trim().toLowerCase()];
    if (!monthNum) return null;

    const fyStart = this._toFyStartYear(selection.financialYear);
    if (!fyStart) return null;

    // Apr–Dec fall in the FY's start year; Jan–Mar in the following year.
    const year = monthNum >= 4 ? Number(fyStart) : Number(fyStart) + 1;
    return `${String(monthNum).padStart(2, '0')}${year}`;
  }

  /** Extract the MMYYYY period a portal-generated return filename refers to. */
  _periodKeyFromFilename(filename) {
    const m = String(filename || '').match(/(0[1-9]|1[0-2])(20\d{2})/);
    return m ? `${m[1]}${m[2]}` : null;
  }

  /**
   * Best-effort diagnostics dump for download failures. Writes a screenshot +
   * JSON (page url, all tab urls, visible control texts) to <tmp>/gst-diag so
   * we can see where a headless flow got stuck. Opt-in via GST_DEBUG=1 (no-op
   * in production otherwise). Never throws; returns the base file path (no
   * extension) or null.
   */
  async _dumpDiag(session, page, label) {
    if (!process.env.GST_DEBUG) return null; // opt-in; no-op in production
    try {
      const dir = path.join(os.tmpdir(), 'gst-diag');
      fs.mkdirSync(dir, { recursive: true });
      const base = path.join(dir, `${label}-${Date.now()}`);
      const info = { label, at: new Date().toISOString() };
      try { info.pageUrl = page.url(); } catch (_) {}
      try {
        const pages = await session.browser.pages();
        info.tabs = pages.map((p) => { try { return p.url(); } catch (_) { return '?'; } });
      } catch (_) {}
      try {
        info.controls = await page.evaluate(() =>
          Array.from(document.querySelectorAll('button,a,input[type=button],input[type=submit],[role="tab"]'))
            .filter((el) => el.offsetWidth || el.offsetHeight || el.getClientRects().length)
            .map((el) => (el.textContent || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 60))
            .filter(Boolean).slice(0, 80));
      } catch (_) {}
      try { await page.screenshot({ path: `${base}.png`, fullPage: true }); } catch (_) {}
      fs.writeFileSync(`${base}.json`, JSON.stringify(info, null, 2));
      return base;
    } catch (_) {
      return null; // best-effort
    }
  }

  /**
   * Generic: call any internal portal API path.
   * If the URL targets services.gst.gov.in and we're not there, navigate via
   * clicking "Search Taxpayer" in the nav (GST blocks direct URL navigation
   * and pop-up tabs, so this single-tab approach is the only reliable path).
   */
  async callPortalApi(sessionId, urlOrPath, method = 'GET', body = null) {
    return rateLimiter.schedule(() => this._callPortalApi(sessionId, urlOrPath, method, body));
  }

  async _callPortalApi(sessionId, urlOrPath, method = 'GET', body = null) {
    const session = sessionManager.getSession(sessionId);
    if (!session?.loggedIn) throw new Error('Not logged in');

    const isAbsolute = /^https?:\/\//i.test(urlOrPath);
    const page = session.page;

    if (isAbsolute) {
      const targetOrigin = new URL(urlOrPath).origin;
      let currentOrigin = null;
      try { currentOrigin = new URL(page.url()).origin; } catch { /* no-op */ }

      if (currentOrigin !== targetOrigin || !page.url().includes('/services/auth/searchtp')) {
        await this._goToSearchTaxpayer(page);
      }
    }

    return page.evaluate(async (url, method, body) => {
      try {
        const headers = {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'X-Requested-With': 'XMLHttpRequest',
        };
        const opts = { method, credentials: 'include', headers };
        if (body && method !== 'GET') opts.body = JSON.stringify(body);
        const resp = await fetch(url, opts);
        const text = await resp.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        if (parsed && (typeof parsed === 'object' || (typeof parsed === 'string' && parsed.length > 0))) {
          return parsed;
        }
        return {
          _empty: true,
          status: resp.status,
          statusText: resp.statusText,
          contentType: resp.headers.get('content-type'),
          url: resp.url,
          redirected: resp.redirected,
          rawLength: text.length,
          fromPage: window.location.href,
          cookieKeys: document.cookie.split(';').map(c => c.split('=')[0].trim()),
        };
      } catch (e) {
        return { error: e.message };
      }
    }, urlOrPath, method, body);
  }

  async _waitForDownload(dir, timeout = 30000) {
    const start = Date.now();
    const seenSizes = new Map();

    while (Date.now() - start < timeout) {
      let filenames = [];
      try {
        filenames = fs.readdirSync(dir);
      } catch (_) {
        await this._sleep(250);
        continue;
      }

      for (const filename of filenames) {
        if (filename.endsWith('.crdownload') || filename.endsWith('.tmp')) continue;

        const filePath = path.join(dir, filename);
        let stats;
        try {
          stats = fs.statSync(filePath);
        } catch (_) {
          continue;
        }

        if (!stats.isFile() || stats.size <= 0) continue;

        const previousSize = seenSizes.get(filename);
        if (previousSize === stats.size) return filename;
        seenSizes.set(filename, stats.size);
      }

      await this._sleep(250);
    }
    return null;
  }

  // ─── HELPERS ──────────────────────────────────────────────────

  _normalizeReturnSelection(options = {}) {
    const returnPeriod = typeof options.returnPeriod === 'string' ? options.returnPeriod.trim() : options.returnPeriod;
    const month = options.month || this._monthFromReturnPeriod(returnPeriod)
      || (typeof returnPeriod === 'string' && !/^\d{6}$/.test(returnPeriod) ? returnPeriod : null);
    const filingPeriod = options.filingPeriod || options.returnFilingPeriod
      || (month ? 'Monthly' : null);

    return {
      financialYear: options.financialYear,
      returnPeriod,
      filingPeriod,
      month,
      returnType: options.returnType,
    };
  }

  _normalizeReturnTypeKey(returnType) {
    return (returnType || '')
      .toString()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '');
  }

  _monthFromReturnPeriod(returnPeriod) {
    if (typeof returnPeriod !== 'string') return null;
    const match = returnPeriod.trim().match(/^(\d{2})\d{4}$/);
    if (!match) return null;

    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    const monthIndex = Number(match[1]) - 1;
    return months[monthIndex] || null;
  }

  async _openViewFiledReturns(session, page) {
    const previousUrl = page.url();
    const viewFiledUrl = 'https://return.gst.gov.in/returns/auth/efiledReturns';
    const steps = { startUrl: previousUrl };
    steps.services = await this._activatePortalMenuItem(page, ['SERVICES'], {
      hover: true,
      click: true,
      preferNav: true,
    });
    await this._settlePortalPage(page, { timeout: 1200, fallbackMs: 80 });
    steps.afterServicesUrl = page.url();

    steps.returns = await this._activatePortalMenuItem(page, ['RETURNS'], {
      hover: true,
      click: true,
      preferNav: true,
    });
    await this._settlePortalPage(page, { timeout: 1200, fallbackMs: 80 });
    steps.afterReturnsUrl = page.url();

    let clickedViewFiled = await this._activatePortalMenuItem(page, ['VIEW FILED RETURNS', 'VIEW E FILED RETURNS'], {
      click: true,
      preferHref: viewFiledUrl,
      preferNav: true,
    });

    if (!clickedViewFiled) {
      clickedViewFiled = await this._activatePortalMenuItem(page, ['VIEW FILED RETURNS', 'VIEW E FILED RETURNS'], {
        click: true,
        preferHref: viewFiledUrl,
      });
    }
    steps.viewFiledClicked = clickedViewFiled;

    if (!clickedViewFiled) {
      clickedViewFiled = await this._clickPortalLinkByHref(page, viewFiledUrl);
      steps.viewFiledClickedByHref = clickedViewFiled;
    }

    if (!clickedViewFiled) {
      // NOTE: do NOT page.goto(viewFiledUrl) here. It's a deep return.gst.gov.in
      // auth link; a direct goto sends Sec-Fetch-Site: none and the F5 WAF
      // answers with /error/accessdenied, poisoning the session. The only
      // reliable path is clicking through Services -> Returns -> View Filed Returns.
      throw new Error('Could not reach "View Filed Returns" via menu clicks (direct navigation is blocked by the GST WAF).');
    }

    await this._waitForPageSwitchOrUrlChange(session, page, previousUrl, {
      targetUrlPart: '/returns/auth/efiledReturns',
      timeout: 8000,
    });

    let activePage = await this._getLatestActivePage(session, page);

    if (!activePage.url().includes('/returns/auth/efiledReturns')) {
      const clickedByHref = await this._clickPortalLinkByHref(activePage, viewFiledUrl);
      if (clickedByHref) {
        await this._waitForPageSwitchOrUrlChange(session, activePage, activePage.url(), {
          targetUrlPart: '/returns/auth/efiledReturns',
          timeout: 8000,
        });
        activePage = await this._getLatestActivePage(session, activePage);
      }
    }

    if (activePage.url().includes('/error/accessdenied')) {
      throw new Error('GST WAF returned accessdenied after navigating to View Filed Returns.');
    }

    if (!activePage.url().includes('/returns/auth/efiledReturns')) {
      await this._dumpDiag(session, activePage, 'view-filed-returns-navigation-failed');
      throw new Error(`Could not reach View Filed Returns; current URL is ${activePage.url()}`);
    }

    return activePage;
  }

  async _clickPortalLinkByHref(page, href) {
    return page.evaluate((href) => {
      const desiredPath = (() => {
        try { return new URL(href, window.location.href).pathname; } catch (_) { return href; }
      })();
      const links = Array.from(document.querySelectorAll('a[href]'));
      const link = links.find((el) => {
        try {
          const url = new URL(el.getAttribute('href'), window.location.href);
          return url.href === href || url.pathname === desiredPath;
        } catch (_) {
          return false;
        }
      });
      if (!link) return false;
      link.click();
      return true;
    }, href);
  }

  async _activatePortalMenuItem(page, texts, { hover = false, click = false, preferHref = '', preferNav = false } = {}) {
    if (!texts || !texts.length) return false;

    return page.evaluate((texts, hover, click, preferHref, preferNav) => {
      const normalize = (value) => (value || '')
        .toString()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const desiredTexts = texts.map(normalize).filter(Boolean);
      const normalizedPreferHref = normalize(preferHref);

      const triggerMouse = (el, type) => {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      };

      const describeNode = (el) => {
        const text = normalize(el.textContent || el.value || '');
        const href = normalize(el.getAttribute('href') || '');
        const id = normalize(el.id || '');
        const className = normalize(el.className || '');
        const role = normalize(el.getAttribute('role') || '');
        const ariaLabel = normalize(el.getAttribute('aria-label') || '');
        const ngClick = normalize(el.getAttribute('ng-click') || el.getAttribute('data-ng-click') || '');
        const onclick = normalize(el.getAttribute('onclick') || '');
        const parentText = normalize((el.parentElement && el.parentElement.textContent) || '');
        return { text, href, id, className, role, ariaLabel, ngClick, onclick, parentText };
      };

      const scoreNode = (el) => {
        const info = describeNode(el);
        const hrefMatches = !!normalizedPreferHref && (
          info.href === normalizedPreferHref || info.href.includes(normalizedPreferHref)
        );
        if (!isVisible(el) && !hrefMatches) return -100;

        let textScore = -100;
        const matchesText = desiredTexts.some((target) => {
          if (info.text === target) {
            textScore = Math.max(textScore, 18);
            return true;
          }
          if (info.text.startsWith(`${target} `) || info.text.endsWith(` ${target}`)) {
            textScore = Math.max(textScore, 12);
            return true;
          }
          if (info.text.includes(` ${target} `)) {
            textScore = Math.max(textScore, 9);
            return true;
          }
          if (info.text.includes(target)) {
            textScore = Math.max(textScore, 5);
            return true;
          }
          return false;
        });

        if (!matchesText && !hrefMatches) return -100;

        let score = hrefMatches ? Math.max(textScore, 25) : textScore;
        if (normalizedPreferHref && info.href === normalizedPreferHref) score += 15;
        if (normalizedPreferHref && info.href.includes(normalizedPreferHref)) score += 10;
        if (preferNav) {
          if (info.className.includes('NAV') || info.role.includes('MENU')) score += 4;
          if (info.parentText.includes('SERVICES') || info.parentText.includes('RETURNS')) score += 3;
        }

        const isInteractive = el.tagName === 'A'
          || el.tagName === 'BUTTON'
          || el.tagName === 'INPUT'
          || info.role.includes('BUTTON')
          || info.role.includes('LINK')
          || info.role.includes('MENUITEM')
          || !!info.href
          || !!info.ngClick
          || !!info.onclick;

        if (isInteractive) score += 5;
        if (info.text.length > 60) score -= 6;
        else if (info.text.length > 30) score -= 3;

        return score;
      };

      const candidates = Array.from(document.querySelectorAll('a, button, span, li, div, input[type="button"]'))
        .map((el) => ({ el, score: scoreNode(el) }))
        .filter((candidate) => candidate.score >= 0)
        .sort((a, b) => b.score - a.score);

      const best = candidates[0];
      if (!best) return false;

      if (hover) {
        triggerMouse(best.el, 'mouseover');
        triggerMouse(best.el, 'mouseenter');
        triggerMouse(best.el, 'mousemove');
      }

      if (click) {
        best.el.click();
      }

      return true;
    }, texts, hover, click, preferHref, preferNav);
  }

  async _selectViewFiledReturnsOption(page, desiredValue, { preferHints = [], avoidHints = [] } = {}) {
    if (!desiredValue) return false;

    // The Financial Year / Month dropdowns' <option> lists are populated
    // asynchronously (Angular fetches them via XHR) after the <select>
    // element itself already exists — a single immediate attempt can race
    // ahead of that and find no matching option yet. Retry briefly, same
    // "poll, don't check once" pattern used elsewhere for this slower box.
    for (let attempt = 0; attempt < 16; attempt++) {
      const ok = await this._trySelectViewFiledReturnsOption(page, desiredValue, preferHints, avoidHints);
      if (ok) return true;
      await this._sleep(300);
    }
    return false;
  }

  async _trySelectViewFiledReturnsOption(page, desiredValue, preferHints, avoidHints) {
    return page.evaluate((desiredValue, preferHints, avoidHints) => {
      const normalize = (value) => (value || '')
        .toString()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const desired = normalize(desiredValue);
      const desiredCompact = desired.replace(/\s+/g, '');
      const wantHints = preferHints.map(normalize).filter(Boolean);
      const skipHints = avoidHints.map(normalize).filter(Boolean);

      const describeSelect = (sel) => {
        const texts = [];
        if (sel.name) texts.push(sel.name);
        if (sel.id) texts.push(sel.id);
        if (sel.getAttribute('aria-label')) texts.push(sel.getAttribute('aria-label'));
        const label = sel.id ? document.querySelector(`label[for="${sel.id}"]`) : null;
        if (label) texts.push(label.textContent);
        let node = sel.parentElement;
        let hops = 0;
        while (node && hops < 3) {
          texts.push(node.textContent || '');
          node = node.parentElement;
          hops += 1;
        }
        return normalize(texts.join(' '));
      };

      const candidates = Array.from(document.querySelectorAll('select'))
        .filter(isVisible)
        .map((sel) => {
          const descriptor = describeSelect(sel);
          let optionMatch = null;

          for (const opt of Array.from(sel.options || [])) {
            const optionText = normalize(opt.textContent || opt.text || '');
            const optionValue = normalize(opt.value || '');
            const compactOptionText = optionText.replace(/\s+/g, '');
            const compactOptionValue = optionValue.replace(/\s+/g, '');

            if (!optionText && !optionValue) continue;
            if (
              optionText === desired
              || optionValue === desired
              || compactOptionText === desiredCompact
              || compactOptionValue === desiredCompact
              || optionText.includes(desired)
              || desired.includes(optionText)
              || compactOptionText.includes(desiredCompact)
              || desiredCompact.includes(compactOptionText)
            ) {
              optionMatch = opt;
              break;
            }
          }

          if (!optionMatch) return null;

          let score = 10;
          if (wantHints.some((hint) => descriptor.includes(hint))) score += 10;
          if (skipHints.some((hint) => descriptor.includes(hint))) score -= 8;
          if (normalize(sel.value || '') === normalize(optionMatch.value || '')) score -= 1;

          return { sel, optionMatch, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);

      const match = candidates[0];
      if (!match) return false;

      match.sel.value = match.optionMatch.value;
      match.sel.dispatchEvent(new Event('input', { bubbles: true }));
      match.sel.dispatchEvent(new Event('change', { bubbles: true }));
      match.sel.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    }, desiredValue, preferHints, avoidHints);
  }

  async _clickFiledReturnViewRow(page, selection = {}) {
    return page.evaluate((selection) => {
      const normalize = (value) => (value || '')
        .toString()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const compact = (value) => normalize(value).replace(/\s+/g, '');
      const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const getReturnCandidates = (value) => {
        const raw = (value || '').toString();
        const parts = raw.split(/[\/,]/).map((part) => normalize(part)).filter(Boolean);
        const candidates = new Set(parts);
        const normalized = normalize(raw);
        if (normalized) candidates.add(normalized);
        const compactNormalized = compact(raw);
        if (compactNormalized) candidates.add(compactNormalized);
        return Array.from(candidates);
      };
      const hasCandidate = (rowText, rowCompact, candidates) => {
        return candidates.some((candidate) => {
          const normalizedCandidate = normalize(candidate);
          const compactCandidate = compact(candidate);
          return (normalizedCandidate && rowText.includes(normalizedCandidate))
            || (compactCandidate && rowCompact.includes(compactCandidate));
        });
      };
      const findViewAction = (container) => {
        return Array.from(container.querySelectorAll('button, a, input[type="button"]')).find((el) => {
          if (!isVisible(el)) return false;
          const text = normalize(el.textContent || el.value || '');
          return text === 'VIEW' || text.startsWith('VIEW ');
        });
      };

      const returnCandidates = getReturnCandidates(selection.returnType);
      const monthCandidates = getReturnCandidates(selection.month);
      const periodCandidates = getReturnCandidates(selection.returnPeriod);
      const rows = Array.from(document.querySelectorAll('tr, .row, .card, .panel'))
        .map((row) => {
          const viewAction = findViewAction(row);
          if (!viewAction) return null;

          const rowText = normalize(row.innerText || row.textContent || '');
          const rowCompact = compact(row.innerText || row.textContent || '');
          let score = 0;

          if (returnCandidates.length && hasCandidate(rowText, rowCompact, returnCandidates)) score += 12;
          if (monthCandidates.length && hasCandidate(rowText, rowCompact, monthCandidates)) score += 10;
          if (periodCandidates.length && hasCandidate(rowText, rowCompact, periodCandidates)) score += 6;
          if (rowText.includes('FILED')) score += 2;
          if (rowText.includes('NOT FILED') || rowText.includes('NO RECORD')) score -= 10;

          return { row, viewAction, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);

      const minimumScore = (returnCandidates.length || monthCandidates.length || periodCandidates.length) ? 6 : 0;
      const best = rows[0];
      if (best && best.score >= minimumScore) {
        best.viewAction.click();
        return true;
      }

      if (minimumScore > 0) return false;

      const fallback = findViewAction(document);
      if (!fallback) return false;
      fallback.click();
      return true;
    }, selection);
  }

  async _getLatestActivePage(session, fallbackPage) {
    const allPages = await session.browser.pages();
    let activePage = fallbackPage;
    if (allPages.length > 1) {
      const latestPage = allPages[allPages.length - 1];
      if (latestPage !== fallbackPage) {
        session.page = latestPage;
        activePage = latestPage;
      }
    }
    return activePage;
  }

  /**
   * Poll the GSTR-1 return page until a recognizable control appears
   * (DOWNLOAD FILED / VIEW SUMMARY / generic DOWNLOAD) or it's clearly
   * not-filed. The Angular return page renders its buttons after the header,
   * and on the slower box a single check can land before they exist — which
   * surfaced as a spurious "No download option found on page". Returns the
   * last observed state once a decision can be made or the timeout elapses.
   */
  async _resolveGstr1PageState(page, timeout = process.platform === 'linux' ? 12000 : 8000) {
    // Event-driven wait: resolves the INSTANT a recognizable control (or a
    // not-filed message) is present, so a ready page costs ~no extra time. Only
    // a genuinely slow/stuck page waits up to `timeout` before we read state.
    await page.waitForFunction(() => {
      const norm = (s) => (s || '').toString().toUpperCase().replace(/\s+/g, ' ').trim();
      const body = norm(document.body.innerText).slice(0, 4000);
      if (body.includes('NOT FILED') || body.includes('NO RECORD FOUND')) return true;
      return Array.from(document.querySelectorAll('button, a, input[type="button"]'))
        .filter((el) => el.offsetWidth || el.offsetHeight || el.getClientRects().length)
        .some((el) => {
          const t = norm(el.textContent || el.value || '');
          return t === 'DOWNLOAD' || t.includes('DOWNLOAD PDF')
            || t.includes('DOWNLOAD FILED') || t.includes('VIEW SUMMARY');
        });
    }, { timeout, polling: 250 }).catch(() => { /* fall through with whatever state exists */ });
    return this._getGstr1PageState(page);
  }

  async _getGstr1PageState(page) {
    return page.evaluate(() => {
      const normalize = (value) => (value || '')
        .toString()
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .trim();
      const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const controls = Array.from(document.querySelectorAll('button, a, input[type="button"]'))
        .filter(isVisible)
        .map((el) => ({
          text: normalize(el.textContent || el.value || ''),
          title: normalize(el.getAttribute('title') || ''),
          ngClick: normalize(el.getAttribute('ng-click') || el.getAttribute('data-ng-click') || ''),
        }));
      const hasDirectPdf = controls.some((control) => {
        return control.text.includes('DOWNLOAD FILED')
          || control.text.includes('DOWNLOAD PDF')
          || control.title.includes('PDF')
          || control.ngClick.includes('GENRATEPDFNEW');
      });
      const hasViewSummary = controls.some((control) => {
        return control.text.includes('VIEW SUMMARY')
          || control.ngClick.includes('VIEWSUMMARY');
      });
      const isDownloadControl = (control) => {
        return control.text === 'DOWNLOAD'
          || control.text.includes('DOWNLOAD PDF')
          || control.text.includes('DOWNLOAD FILED')
          || control.title.includes('PDF')
          || control.ngClick.includes('GENRATEPDFNEW');
      };
      const hasAnyDownload = controls.some(isDownloadControl);
      const bodyText = normalize(document.body.innerText).substring(0, 4000);
      const notFiled = bodyText.includes('NOT FILED') || bodyText.includes('NO RECORD FOUND');

      return {
        hasDirectPdf,
        hasDownloadFiled: hasDirectPdf,
        hasViewSummary,
        hasAnyDownload,
        hasDownload: hasAnyDownload,
        notFiled,
        controls: controls.slice(0, 40),
        texts: controls.slice(0, 40).map((control) => control.text || control.title || control.ngClick),
      };
    });
  }

  async _getGstr3bPageState(page) {
    return page.evaluate(() => {
      const normalize = (value) => (value || '')
        .toString()
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .trim();
      const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const controls = Array.from(document.querySelectorAll('button, a, input[type="button"]'))
        .filter(isVisible)
        .map((el) => {
          const container = el.closest('.modal, [role="dialog"], .popup, .panel, .card, .modal-content') || el.parentElement;
          return {
            text: normalize(el.textContent || el.value || ''),
            title: normalize(el.getAttribute('title') || ''),
            ariaLabel: normalize(el.getAttribute('aria-label') || ''),
            dataDismiss: normalize(el.getAttribute('data-dismiss') || ''),
            ngClick: normalize(el.getAttribute('ng-click') || el.getAttribute('data-ng-click') || ''),
            href: normalize(el.getAttribute('href') || ''),
            containerText: normalize((container && container.innerText) || ''),
          };
        });

      const hasFiledPdf = controls.some((control) => {
        return control.text.includes('DOWNLOAD FILED GSTR-3B')
          || control.text.includes('DOWNLOAD FILED GSTR 3B')
          || (control.text.includes('DOWNLOAD FILED') && control.text.includes('GSTR'))
          || control.ngClick.includes('SHOWPDF')
          || control.href.includes('SHOWPDF')
          || (control.title.includes('PDF') && control.text.includes('GSTR-3B'));
      });
      const hasSystemGenerated = controls.some((control) => control.text.includes('SYSTEM GENERATED GSTR-3B') || control.text.includes('SYSTEM GENERATED GSTR 3B'));
      const hasSummaryPopup = controls.some((control) => {
        const closeMatch = control.text === 'CLOSE' || control.title === 'CLOSE' || control.ariaLabel === 'CLOSE' || control.dataDismiss.includes('MODAL');
        const summaryContext = control.containerText.includes('SYSTEM GENERATED SUMMARY')
          || control.containerText.includes('SUMMARY STATUS')
          || control.containerText.includes('GSTR-3B TABLE')
          || control.containerText.includes('ADVISORY');
        return closeMatch && summaryContext;
      });
      const bodyText = normalize(document.body.innerText).substring(0, 12000);
      const hasFiledStatus = bodyText.includes('STATUS - FILED')
        || bodyText.includes('STATUS FILED')
        || bodyText.includes('DOWNLOAD FILED GSTR-3B')
        || bodyText.includes('DOWNLOAD FILED GSTR 3B');
      const hasNotFiledStatus = bodyText.includes('STATUS - NOT FILED')
        || bodyText.includes('STATUS NOT FILED')
        || bodyText.includes('NO RECORD FOUND');
      const notFiled = hasNotFiledStatus
        && !hasFiledStatus
        && !hasFiledPdf
        && !hasSystemGenerated
        && !hasSummaryPopup;

      return {
        hasFiledPdf,
        hasSystemGenerated,
        hasSummaryPopup,
        notFiled,
        hasFiledStatus,
        controls: controls.slice(0, 50),
      };
    });
  }

  async _clickViewSummaryButton(page) {
    return page.evaluate(() => {
      const normalize = (value) => (value || '')
        .toString()
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .trim();
      const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const btn = Array.from(document.querySelectorAll('button, a, input[type="button"]'))
        .find((el) => {
          if (!isVisible(el)) return false;
          const text = normalize(el.textContent || el.value || '');
          const ngClick = normalize(el.getAttribute('ng-click') || el.getAttribute('data-ng-click') || '');
          return text.includes('VIEW SUMMARY') || ngClick.includes('VIEWSUMMARY');
        });
      if (!btn) return false;
      btn.click();
      return true;
    });
  }

  async _dismissGstr3bSummaryPopup(page) {
    const dismissed = await page.evaluate(() => {
      const normalize = (value) => (value || '')
        .toString()
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .trim();
      const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

      const candidates = Array.from(document.querySelectorAll('button, a, input[type="button"]'))
        .filter(isVisible)
        .map((el) => {
          const text = normalize(el.textContent || el.value || '');
          const title = normalize(el.getAttribute('title') || '');
          const ariaLabel = normalize(el.getAttribute('aria-label') || '');
          const dataDismiss = normalize(el.getAttribute('data-dismiss') || '');
          const container = el.closest('.modal, [role="dialog"], .popup, .panel, .card, .modal-content') || el.parentElement;
          const containerText = normalize((container && container.innerText) || '');
          let score = -100;

          if (text === 'CLOSE' || title === 'CLOSE' || ariaLabel === 'CLOSE') score = 10;
          else if (dataDismiss.includes('MODAL')) score = 9;
          else if (text.includes('CLOSE')) score = 8;

          if (
            containerText.includes('SYSTEM GENERATED SUMMARY')
            || containerText.includes('SUMMARY STATUS')
            || containerText.includes('GSTR-3B TABLE')
            || containerText.includes('ADVISORY')
          ) {
            score += 5;
          }

          if (el.closest('.modal, [role="dialog"], .popup, .modal-content')) {
            score += 3;
          }

          return { el, score };
        })
        .sort((a, b) => b.score - a.score);

      const best = candidates[0];
      if (!best || best.score < 10) return false;
      best.el.click();
      return true;
    });

    if (dismissed) {
      await this._settlePortalPage(page, { timeout: 1500, fallbackMs: 100 });
    }

    return dismissed;
  }

  async _waitForGstr1SummaryPdf(page, timeout = 12000) {
    await page.waitForFunction(() => {
      const normalize = (value) => (value || '')
        .toString()
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .trim();
      const controls = Array.from(document.querySelectorAll('button, a, input[type="button"]'));
      const hasPdfButton = controls.some((el) => {
        const text = normalize(el.textContent || el.value || '');
        const title = normalize(el.getAttribute('title') || '');
        const ngClick = normalize(el.getAttribute('ng-click') || el.getAttribute('data-ng-click') || '');
        return title.includes('PDF')
          || text.includes('DOWNLOAD PDF')
          || text === 'PDF'
          || ngClick.includes('GENRATEPDFNEW');
      });
      if (hasPdfButton) return true;

      if (window.angular && window.angular.element) {
        const scopeRoots = [document.body, ...Array.from(document.querySelectorAll('[ng-controller], [data-ng-controller]'))];
        return scopeRoots.some((root) => {
          try {
            const scope = window.angular.element(root).scope();
            return !!(scope && scope.sumryData);
          } catch (_) {
            return false;
          }
        });
      }

      return false;
    }, { timeout }).catch(() => {});

    await this._settlePortalPage(page, { timeout: 1200, fallbackMs: 80 });
  }

  async _clickGstr3bPdfButton(page, { allowGenericDownload = true, allowSystemGenerated = false } = {}) {
    return page.evaluate((allowGenericDownload, allowSystemGenerated) => {
      const normalize = (value) => (value || '')
        .toString()
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .trim();
      const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const controls = Array.from(document.querySelectorAll('button, a, input[type="button"]'))
        .filter(isVisible)
        .map((el) => {
          const text = normalize(el.textContent || el.value || '');
          const title = normalize(el.getAttribute('title') || '');
          const ngClick = normalize(el.getAttribute('ng-click') || el.getAttribute('data-ng-click') || '');
          const href = normalize(el.getAttribute('href') || '');
          let score = -100;
          let source = 'unknown';

          if (text.includes('DOWNLOAD FILED GSTR-3B') || text.includes('DOWNLOAD FILED GSTR 3B')) {
            score = 60;
            source = 'filed-pdf';
          } else if ((text.includes('DOWNLOAD FILED') && text.includes('GSTR')) || ngClick.includes('SHOWPDF') || href.includes('SHOWPDF')) {
            score = 50;
            source = 'filed-pdf';
          } else if (title.includes('PDF') || text.includes('DOWNLOAD PDF')) {
            score = 40;
            source = 'pdf';
          } else if (
            allowGenericDownload
            && (text === 'DOWNLOAD' || text.includes('DOWNLOAD PDF') || text.includes('DOWNLOAD FILED'))
          ) {
            score = 20;
            source = 'generic-download';
          }

          if (!allowSystemGenerated && (text.includes('SYSTEM GENERATED GSTR-3B') || text.includes('SYSTEM GENERATED GSTR 3B'))) {
            score = -100;
          }

          if (allowSystemGenerated && (text.includes('SYSTEM GENERATED GSTR-3B') || text.includes('SYSTEM GENERATED GSTR 3B'))) {
            score = Math.max(score, 25);
            source = 'system-generated-pdf';
          }

          return { el, text, title, score, source };
        })
        .sort((a, b) => b.score - a.score);

      const best = controls[0];
      if (!best || best.score < 0) return null;
      best.el.click();
      return {
        label: best.text || best.title || null,
        source: best.source,
      };
    }, allowGenericDownload, allowSystemGenerated);
  }

  async _clickGstr1PdfButton(page, { allowGenericDownload = false } = {}) {
    return page.evaluate((allowGenericDownload) => {
      const normalize = (value) => (value || '')
        .toString()
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .trim();
      const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const controls = Array.from(document.querySelectorAll('button, a, input[type="button"]'))
        .filter(isVisible);

      const pdfButton = controls.find((el) => {
        const text = normalize(el.textContent || el.value || '');
        const title = normalize(el.getAttribute('title') || '');
        const ngClick = normalize(el.getAttribute('ng-click') || el.getAttribute('data-ng-click') || '');
        return title.includes('PDF')
          || text.includes('DOWNLOAD FILED')
          || text.includes('DOWNLOAD PDF')
          || text === 'PDF'
          || ngClick.includes('GENRATEPDFNEW');
      });

      if (pdfButton) {
        pdfButton.click();
        return true;
      }

      if (!allowGenericDownload) return false;

      const fallback = controls.find((el) => {
        const text = normalize(el.textContent || el.value || '');
        return text === 'DOWNLOAD'
          || text.includes('DOWNLOAD PDF')
          || text.includes('DOWNLOAD FILED');
      });
      if (!fallback) return false;
      fallback.click();
      return true;
    }, allowGenericDownload);
  }

  async _sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async _settlePortalPage(page, { timeout = 900, fallbackMs = 60 } = {}) {
    // waitForNetworkIdle returns the moment the page goes quiet; the timeout is
    // only a ceiling for the GST SPA's long-lived connections that never idle.
    // Kept small on purpose — the critical button check (_resolveGstr1PageState)
    // waits event-driven for readiness, so these settles don't need big ceilings.
    await page.waitForNetworkIdle({ timeout, idleTime: 350 }).catch(() => {});
    await this._sleep(fallbackMs);
  }

  async _waitForPageSwitchOrUrlChange(session, page, previousUrl, { targetUrlPart = '', timeout = 8000 } = {}) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const latestPage = await this._getLatestActivePage(session, page);
      if (latestPage !== page) return latestPage;

      const currentUrl = page.url();
      if (currentUrl !== previousUrl) {
        if (!targetUrlPart || currentUrl.includes(targetUrlPart)) {
          return page;
        }
      }

      await this._sleep(100);
    }

    return this._getLatestActivePage(session, page);
  }

  async _waitForLoginResult(page, previousUrl, timeout = 8000) {
    await page.waitForFunction((prevUrl) => {
      const urlChanged = window.location.href !== prevUrl;
      const hasCaptcha = !!document.querySelector('#imgCaptcha, .captcha-img, img[alt*="captcha" i]');
      const hasError = !!document.querySelector('.error-msg, .alert-danger, #err_message, .err, .text-danger');
      const onDashboard = window.location.href.includes('fowelcome') || window.location.href.includes('dashboard');
      return urlChanged || hasCaptcha || hasError || onDashboard;
    }, { timeout }, previousUrl).catch(() => {});

    await this._settlePortalPage(page, { timeout: 1500, fallbackMs: 100 });
  }

  async _waitForOptionalModal(page, timeout = 1200) {
    await page.waitForFunction(() => {
      const closeBtn = document.querySelector('.modal .close, [data-dismiss="modal"]');
      const laterBtn = Array.from(document.querySelectorAll('button, a, input[type="button"]')).find((btn) => {
        const text = (btn.textContent || btn.value || '').toUpperCase().trim();
        return text.includes('REMIND ME LATER') || text.includes('NO-REMIND') || text.includes('LATER');
      });
      return !!closeBtn || !!laterBtn;
    }, { timeout }).catch(() => {});
  }

  async _navigateToReturnsDashboard(session) {
    const { page } = session;
    await this._goToSearchTaxpayer(page);
  }

  /**
   * Land on /services/auth/searchtp by CLICKING the nav link — never by
   * page.goto(). A direct goto sends `Sec-Fetch-Site: none` (same as typing a
   * deep URL in the address bar), which the F5 WAF rejects with
   * /services/error/accessdenied. Clicking sends `Sec-Fetch-Site: same-origin`,
   * which is the only way a real user reaches these internal pages.
   */
  async _goToSearchTaxpayer(page) {
    if (page.url().includes('/services/auth/searchtp')) return;

    // The "Search Taxpayer" top-nav item is only a dropdown toggle (href="#").
    // The page we want is the "Search by GSTIN/UIN" submenu link
    // (/services/auth/searchtp). Open the dropdown, then click the submenu
    // anchor — a real link click sends `Sec-Fetch-Site: same-origin`, which the
    // F5 WAF allows; a direct page.goto sends `none` and gets accessdenied.
    const clicked = await page.evaluate(() => {
      const norm = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      // open the "Search Taxpayer" dropdown (mirrors a real hover/click)
      const toggle = Array.from(document.querySelectorAll('a')).find((a) => norm(a) === 'search taxpayer');
      if (toggle) {
        toggle.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        toggle.click();
      }
      // click the GSTIN/UIN search link
      const target = Array.from(document.querySelectorAll('a')).find((a) =>
        a.href && a.href.includes('/services/auth/searchtp'));
      if (target) { target.click(); return true; }
      return false;
    });

    if (!clicked) {
      throw new Error('Could not find the "Search by GSTIN/UIN" nav link to click (direct navigation is blocked by the GST WAF).');
    }

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});

    if (page.url().includes('/error/accessdenied')) {
      throw new Error('GST WAF returned accessdenied after navigating to Search Taxpayer.');
    }
  }

  async _dismissPopup(page) {
    await this._waitForOptionalModal(page, 1200);
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, a, input[type="button"]');
      for (const btn of buttons) {
        const text = btn.textContent.toUpperCase().trim();
        if (text.includes('REMIND ME LATER') || text.includes('NO-REMIND') || text.includes('LATER')) {
          btn.click();
          return true;
        }
      }
      const closeBtn = document.querySelector('.modal .close, [data-dismiss="modal"]');
      if (closeBtn) { closeBtn.click(); return true; }
      return false;
    });
    await this._settlePortalPage(page, { timeout: 1200, fallbackMs: 80 });
  }

  async _checkCaptcha(page) {
    const captchaEl = await page.$('#imgCaptcha, .captcha-img, img[alt*="captcha" i]');
    if (captchaEl) {
      const visible = await page.evaluate(el => el.offsetParent !== null, captchaEl);
      if (visible) {
        const captchaBase64 = await captchaEl.screenshot({ encoding: 'base64' });
        return { hasCaptcha: true, captchaBase64 };
      }
    }
    return { hasCaptcha: false, captchaBase64: null };
  }

  async _getErrorMessage(page) {
    return page.evaluate(() => {
      const selectors = ['.error-msg', '.alert-danger', '#err_message', '.err', '.text-danger'];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim() && el.offsetParent !== null) return el.textContent.trim();
      }
      return null;
    });
  }

  // ─── NOTICES (logged-in taxpayer's OWN notices/orders) ───────────
  // Notices are private: only fetchable for the GSTIN we're logged in as.

  /**
   * Reach a notices module by CLICKING nav (never page.goto — WAF-blocked).
   * `which` = 'additional' | 'legacy'. Opens the Services → User Services menu
   * so the submenu anchors render, then clicks the notices link by its visible
   * text. Returns { clicked, targetText?, noticeNavTexts } — the nav-text list
   * is diagnostic so we can adjust the match if the label differs.
   */
  async _navigateToNotices(session, which) {
    const page = session.page;
    const NOTICES_PATH = '/services/auth/notices';

    // Already on the notices page (e.g. the 2nd section of a 'both' fetch) — reuse.
    if (page.url().includes(NOTICES_PATH)) {
      return { clicked: true, targetHref: page.url(), landedUrl: page.url(), reused: true };
    }

    // Reach the notices page by CLICKING the anchor whose href points at it.
    // This is robust to menu LAYOUT (dropdown vs collapsed/hamburger at the
    // headless viewport) and avoids clicking the top-level "Services" item, which
    // on some pages NAVIGATES to the public /services/quicklinks/services list
    // instead of toggling a menu. First ensure we're on an authenticated services
    // page that carries the nav (drifted/ litserv pages don't).
    if (!/services\.gst\.gov\.in\/services\/auth\//.test(page.url()) || /\/error\//.test(page.url())) {
      await this._goToSearchTaxpayer(page).catch(() => {});
      await this._settlePortalPage(page, { timeout: 2000, fallbackMs: 120 }).catch(() => {});
    }

    // Retry — the notices anchor may be lazily added and the capped box is slow.
    let info = { clicked: false };
    let navSample = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      info = await page.evaluate((path) => {
        const norm = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const nodes = Array.from(document.querySelectorAll('a, button'));
        // Expand the "User Services" menu so a lazy notices anchor mounts. Only
        // "click" it if it's a real toggle (href '' / '#' / javascript:), never a
        // navigating link.
        const tog = nodes.find((n) => norm(n) === 'user services' || norm(n).startsWith('user services'));
        if (tog) {
          tog.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
          tog.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          const h = (tog.getAttribute('href') || '').trim().toLowerCase();
          if (h === '' || h === '#' || h.startsWith('javascript')) tog.click();
        }
        // Click the notices anchor by href (protocol-relative "//host/..." is fine).
        const link = Array.from(document.querySelectorAll('a')).find((a) => (a.getAttribute('href') || '').includes(path));
        const sample = [...new Set(nodes.map(norm).filter(Boolean))].slice(0, 60);
        if (link) { const href = link.getAttribute('href'); link.click(); return { clicked: true, targetHref: href, navSample: sample }; }
        return { clicked: false, navSample: sample };
      }, NOTICES_PATH);
      navSample = info.navSample || navSample;
      if (info.clicked) break;
      await this._sleep(500 + attempt * 700);
    }

    if (info.clicked) {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
      await this._settlePortalPage(page, { timeout: 2000, fallbackMs: 120 });
      info.landedUrl = page.url();
    } else {
      info.currentUrl = page.url();
      info.navSample = navSample;
    }
    return info;
  }

  /**
   * Fetch the logged-in taxpayer's notices/orders as a normalized list.
   * `section` = 'both' (default) | 'additional' | 'legacy'. Navigates to each
   * module (WAF-safe click nav), lets the page fire its own XHRs, and merges the
   * scraped table (display truth) with the captured API objects so each notice
   * also carries the download identifiers (docId/applnId/caseId/arn).
   */
  async getNotices(sessionId, { section = 'both' } = {}) {
    const session = sessionManager.getSession(sessionId);
    if (!session?.loggedIn) throw new Error('Not logged in');

    const wanted = section === 'both' ? ['additional', 'legacy'] : [section];
    const sections = {};
    const all = [];
    const seenUrls = new Set();
    for (const which of wanted) {
      const r = await this._getNoticesSection(session, which);
      sections[which] = r;
      // The portal appears to have merged "View Notices and Orders" into the
      // unified /services/auth/notices page, so a second section can resolve to
      // the same URL. Don't double-list those in the merged array.
      if (r.landedUrl && seenUrls.has(r.landedUrl)) {
        r.note = 'Resolved to the same page as an earlier section (portal merged these modules); notices omitted from the merged list to avoid duplicates.';
        continue;
      }
      if (r.landedUrl) seenUrls.add(r.landedUrl);
      for (const n of r.notices) all.push({ ...n, section: which });
    }
    return { count: all.length, notices: all, sections };
  }

  async _getNoticesSection(session, which) {
    const page = session.page;

    // Capture the notice-list XHRs the page fires while it renders.
    const captured = [];
    const handler = async (response) => {
      const url = response.url();
      if (!/\/api\/get\/notices|\/case\/task\/get/.test(url)) return;
      try {
        const text = await response.text().catch(() => null);
        if (!text) return;
        let data; try { data = JSON.parse(text); } catch { return; }
        captured.push({ url, data });
      } catch (_) { /* best-effort */ }
    };
    page.on('response', handler);

    let nav;
    let table = null;
    try {
      nav = await this._navigateToNotices(session, which);
      if (nav.clicked) {
        // Wait for the notices table to POPULATE — on the capped box the
        // get/notices + case/task/get XHRs land well after navigation, so an
        // immediate scrape returned 0 rows.
        await page.waitForFunction(() => {
          const t = document.querySelector('table');
          return t && t.querySelectorAll('tbody tr').length > 0;
        }, { timeout: 20000 }).catch(() => {});
        table = await page.evaluate(() => {
          const t = document.querySelector('table');
          if (!t) return null;
          return {
            headers: Array.from(t.querySelectorAll('th')).map((th) => th.textContent.trim()),
            rows: Array.from(t.querySelectorAll('tbody tr')).map((r) =>
              Array.from(r.querySelectorAll('td')).map((td) => td.textContent.trim())),
          };
        }).catch(() => null);
      }
    } finally {
      page.off('response', handler);
    }

    if (!nav.clicked) {
      return {
        notices: [],
        warning: `Could not open the "${which}" notices menu.`,
        navLabelsSeen: nav.noticeNavTexts,
        currentUrl: nav.currentUrl || null,
        navSample: nav.navSample || null,
      };
    }

    // Index captured API objects by their id for enrichment.
    const byId = new Map();
    for (const c of captured) {
      if (!Array.isArray(c.data)) continue;
      for (const o of c.data) {
        if (o && o.refId) byId.set(o.refId, { source: 'case', obj: o });
        else if (o && o.noticeOrderId) byId.set(o.noticeOrderId, { source: 'order', obj: o });
      }
    }

    const notices = (table?.rows || []).map((cells) => {
      const [id, type, description, dateOfIssue, dueDate, action] = cells;
      const match = byId.get(id);
      const o = match?.obj || {};
      return {
        id,
        type: type || null,
        description: description || null,
        dateOfIssue: dateOfIssue || null,
        dueDate: dueDate && dueDate !== 'NA' ? dueDate : null,
        action: action || null,
        source: match?.source || null,
        issuedBy: o.issuedBy ?? null,
        amount: o.amount && o.amount !== 'NA' ? o.amount : null,
        isRead: o.isRead != null ? o.isRead === 'Y' : null,
        status: o.status ?? o.authStatus ?? null,
        arn: o.arn ?? null,
        // identifiers we'll use for document download (Phase: download)
        refs: {
          docId: o.docId ?? null,
          applnId: o.applnId ?? null,
          applnCd: o.applnCd ?? null,
          caseId: o.caseId ?? null,
          caseTypeCd: o.caseTpeCd ?? null,
          caseFolderItemId: o.caseFolderItemId ?? null,
        },
      };
    });

    return { landedUrl: nav.landedUrl || null, targetHref: nav.targetHref || null, count: notices.length, notices };
  }

  /**
   * Download an ORDER-type notice document as base64. Order notices (from
   * /services/auth/api/get/notices) expose the PDF directly at
   * GET /document/{docId}/{applnId} — the same URL the portal opens on "View".
   * Pass the docId + applnId from a GET /notices order-type notice's `refs`.
   */
  async downloadOrderNotice(sessionId, { docId, applnId }) {
    if (!docId || !applnId) throw new Error('docId and applnId are required (from an order-type notice\'s refs)');

    // Notices are immutable once issued — cache like filed returns.
    const session = sessionManager.getSession(sessionId);
    const gstin = session?.userInfo?.gstin;
    const cacheKey = gstin ? this._pdfCacheKey('NOTICE', gstin, `${docId}_${applnId}`) : null;
    if (cacheKey) {
      const cached = this._readCachedPdf(cacheKey);
      if (cached) return cached;
    }

    const url = `https://services.gst.gov.in/document/${docId}/${applnId}`;
    const result = await this._downloadBinaryInPage(sessionId, url);
    if (cacheKey && result?.base64) {
      this._writeCachedPdf(cacheKey, Buffer.from(result.base64, 'base64'));
    }
    return result;
  }

  /**
   * Fetch a same-origin binary document (PDF) with the logged-in session's
   * cookies and return it base64-encoded. Ensures we're on a services.gst.gov.in
   * page first (same-origin + WAF), then does an in-page fetch → arrayBuffer →
   * base64. Serialized through the rate limiter like the other portal calls.
   */
  async _downloadBinaryInPage(sessionId, url) {
    return rateLimiter.schedule(async () => {
      const session = sessionManager.getSession(sessionId);
      if (!session?.loggedIn) throw new Error('Not logged in');
      const page = session.page;

      let onServices = false;
      try { onServices = new URL(page.url()).origin === 'https://services.gst.gov.in' && !page.url().includes('/error/'); } catch (_) {}
      if (!onServices) await this._goToSearchTaxpayer(page);

      const result = await page.evaluate(async (url) => {
        try {
          const resp = await fetch(url, { credentials: 'include' });
          const buf = await resp.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = '';
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
          }
          return {
            ok: resp.ok,
            status: resp.status,
            contentType: resp.headers.get('content-type') || '',
            base64: btoa(binary),
            size: bytes.length,
          };
        } catch (e) { return { error: e.message }; }
      }, url);

      if (result.error) throw new Error(`Document fetch failed: ${result.error}`);
      if (!result.ok) throw new Error(`Document fetch failed: HTTP ${result.status}`);
      // A tiny "PDF" is usually an HTML error/redirect, not a real document.
      const looksHtml = /text\/html/i.test(result.contentType);
      if (looksHtml) throw new Error(`Expected a document but got HTML (likely a WAF/redirect); size=${result.size}`);
      return {
        mimeType: result.contentType || 'application/pdf',
        size: result.size,
        base64: result.base64,
      };
    });
  }

  /**
   * List the documents inside a CASE-type notice's case folder. Walks the
   * litserv case-folder chain (folders → items → parse itemJson for docs). Pass
   * caseId + arn + caseTypeCd from a case-type notice (refs.caseId, arn,
   * refs.caseTypeCd).
   * Returns { documents: [{ docName, docId, contentType, docType, folder, refId }] }.
   * Use a document's `docName` with POST /notices/case/download to fetch it.
   */
  async getCaseDocuments(sessionId, { caseId, arn, caseTypeCd } = {}) {
    const session = sessionManager.getSession(sessionId);
    if (!session?.loggedIn) throw new Error('Not logged in');
    if (!caseId || !arn || !caseTypeCd) {
      throw new Error('caseId, arn and caseTypeCd are required (from a case-type notice: refs.caseId, arn, refs.caseTypeCd)');
    }
    const gstin = session.userInfo?.gstin;
    if (!gstin) throw new Error('Could not determine the logged-in GSTIN from the session');

    const folders = await this.callPortalApi(
      sessionId, 'https://services.gst.gov.in/litserv/auth/api/case/folder', 'POST',
      { caseId, gstid: gstin, caseTypeCd });

    const docs = [];
    const seen = new Set();
    for (const f of (Array.isArray(folders) ? folders : [])) {
      if (!f?.caseFolderId) continue;
      const items = await this.callPortalApi(
        sessionId, 'https://services.gst.gov.in/litserv/auth/api/case/folder/items', 'POST',
        { caseFolderId: f.caseFolderId });
      for (const it of (Array.isArray(items) ? items : [])) {
        let parsed = null;
        try { parsed = JSON.parse(it.itemJson); } catch { /* non-JSON item */ }
        const found = [];
        this._collectDocs(parsed, found, new Set());
        for (const d of found) {
          if (seen.has(d.docId)) continue;
          seen.add(d.docId);
          docs.push({ ...d, folder: f.caseFolderTypeName || null, folderType: f.caseFolderTypeCd || null, refId: it.refId || null });
        }
      }
    }

    return { caseId, arn, caseTypeCd, count: docs.length, documents: docs };
  }

  /**
   * Download one document from a case-type notice's case folder as base64. The
   * portal serves case documents only via a click that streams the file (the
   * URL is protected and returns an attachment), so we drive the UI: open the
   * notice's case folder, click the document whose name matches, and read the
   * downloaded file. Body: { id: notice id, docName: from getCaseDocuments,
   * folder?: the document's `folder` field from getCaseDocuments — when given
   * and it matches a known tab, that tab is tried first instead of scanning
   * every tab in a fixed order }.
   */
  async downloadCaseDocument(sessionId, { id, docName, folder } = {}) {
    const session = sessionManager.getSession(sessionId);
    if (!session?.loggedIn) throw new Error('Not logged in');
    if (!id || !docName) throw new Error('id (the notice id) and docName are required (docName from GET /notices/case/documents)');

    // Case documents are immutable once filed — cache like filed returns, but
    // without the PDF-only assumption (case docs can be pdf/zip/jpg/png).
    const gstin = session.userInfo?.gstin;
    const cacheKey = gstin
      ? `CASEDOC_${this._sanitizeCacheSegment(gstin)}_${this._sanitizeCacheSegment(id)}_${this._sanitizeCacheSegment(docName)}`
      : null;
    if (cacheKey) {
      const cached = this._readCacheBuffer(cacheKey);
      if (cached) {
        return { filename: docName, size: cached.length, mimeType: 'application/pdf', base64: cached.toString('base64'), cached: true };
      }
    }

    const page = session.page;
    const downloadDir = session.downloadDir;

    const opened = await this._openNoticeCaseFolder(session, id);
    if (!opened.ok) throw new Error(opened.reason || `Could not open the case folder for notice ${id}`);
    const folderUrl = page.url();

    // Start from an empty download dir so we grab exactly this file.
    try { for (const f of fs.readdirSync(downloadDir)) fs.unlinkSync(path.join(downloadDir, f)); } catch (_) {}

    const tryClickDoc = () => page.evaluate((docName) => {
      // The portal's on-page link text often omits the file extension that
      // getCaseDocuments' docName carries (e.g. anchor "Notice of Personal
      // Hearing" vs docName "Notice of Personal Hearing.pdf"), and can differ
      // in case too (anchor "virtual hearing" vs docName "Virtual Hearing.pdf")
      // — strip a trailing extension and lowercase both sides before
      // comparing, and match in either direction since either string can be
      // the longer one.
      const stripExt = (s) => (s || '').replace(/\.(pdf|zip|jpe?g|png|docx?|xlsx?)$/i, '');
      const norm = (s) => stripExt((s || '').replace(/\s+/g, ' ').trim()).toLowerCase();
      const GENERIC = new Set(['back', 'reply', 'view', 'edit', 'submit', 'cancel', 'close', 'print', 'download']);
      const want = norm(docName);
      const anchors = Array.from(document.querySelectorAll('a'));
      const target = anchors.find((a) => norm(a.textContent) === want)
        || anchors.find((a) => {
          const t = norm(a.textContent);
          if (!t || t.length < 8 || GENERIC.has(t)) return false;
          return t.includes(want) || want.includes(t);
        });
      if (target) { target.click(); return { ok: true }; }
      const names = [...new Set(anchors.map((a) => (a.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 60);
      return { ok: false, docsSeen: names };
    }, docName);

    let clicked = await tryClickDoc();
    const allDocsSeen = new Set(clicked.docsSeen || []);

    // The case folder is organized into category tabs (NOTICES, REPLIES,
    // ORDERS, APPLICATIONS, ...) — only one is active/rendered by default, so
    // the target document may sit under a tab we haven't opened yet. If the
    // caller told us which folder this document came from (from
    // getCaseDocuments), try that tab first — usually finds it in one hop
    // instead of cycling every tab. Click through the rest (same client-side
    // page — same litserv/case/folder URL), re-scanning after each and
    // bailing out if a click ever navigates away.
    if (!clicked.ok) {
      const hinted = CASE_FOLDER_TABS.find((t) => t.toLowerCase() === String(folder || '').trim().toLowerCase());
      const tabOrder = hinted ? [hinted, ...CASE_FOLDER_TABS.filter((t) => t !== hinted)] : CASE_FOLDER_TABS;
      for (const tabLabel of tabOrder) {
        if (page.url() !== folderUrl) break; // unexpected navigation — stop
        const switched = await page.evaluate((label) => {
          const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toUpperCase();
          const el = Array.from(document.querySelectorAll('a, button, [role="tab"], li, span'))
            .find((n) => norm(n.textContent) === label && (n.offsetWidth || n.offsetHeight || n.getClientRects().length));
          if (el) { el.click(); return true; }
          return false;
        }, tabLabel);
        if (!switched) continue;
        await this._sleep(400);
        await this._settlePortalPage(page, { timeout: 1200, fallbackMs: 100 }).catch(() => {});
        if (page.url() !== folderUrl) break; // tab click navigated away — stop
        clicked = await tryClickDoc();
        for (const d of (clicked.docsSeen || [])) allDocsSeen.add(d);
        if (clicked.ok) break;
      }
    }

    if (!clicked.ok) {
      const dumpPath = await this._dumpDiag(session, page, 'case-doc-not-found');
      const dumpNote = dumpPath ? ` Diagnostic dump: ${dumpPath}` : '';
      throw new Error(`Document "${docName}" not found in the case folder (checked all tabs). Documents visible: ${JSON.stringify([...allDocsSeen])}.${dumpNote}`);
    }

    const file = await this._waitForDownload(downloadDir, DOWNLOAD_TIMEOUT_MS);
    if (!file) throw new Error('Case document download timed out');
    const filePath = path.join(downloadDir, file);
    const buffer = fs.readFileSync(filePath);
    fs.rmSync(filePath, { force: true });
    if (cacheKey) this._writeCacheBuffer(cacheKey, buffer);
    return { filename: file, size: buffer.length, mimeType: 'application/pdf', base64: buffer.toString('base64') };
  }

  /**
   * Open a case-type notice's case folder by clicking its row's "View" in the
   * Additional Notices table (WAF-safe click nav). Returns { ok, url }.
   */
  async _openNoticeCaseFolder(session, id) {
    const page = session.page;
    await this._navigateToNotices(session, 'additional');
    // Wait for the notices table to populate before looking for the row (slow box).
    await page.waitForFunction(() => {
      const t = document.querySelector('table');
      return t && t.querySelectorAll('tbody tr').length > 0;
    }, { timeout: 20000 }).catch(() => {});
    const clicked = await page.evaluate((id) => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      for (const r of rows) {
        const cells = Array.from(r.querySelectorAll('td')).map((td) => td.textContent.trim());
        if (cells[0] === id) {
          const el = Array.from(r.querySelectorAll('a, button')).find((e) => /view/i.test(e.textContent || ''));
          if (el) { el.click(); return { ok: true }; }
          return { ok: false, reason: 'row found but no View control' };
        }
      }
      return { ok: false, reason: `no notice row matched id ${id}` };
    }, id);
    if (!clicked.ok) return clicked;
    await this._sleep(4000);
    await this._settlePortalPage(page, { timeout: 3000, fallbackMs: 150 }).catch(() => {});
    const url = page.url();
    if (!/litserv\/auth\/case\/folder/.test(url)) {
      return { ok: false, reason: `notice ${id} did not open a case folder (landed on ${url}) — is it a case-type notice?` };
    }
    return { ok: true, url };
  }

  /**
   * Recursively collect document descriptors from a parsed case-folder itemJson.
   * Docs appear as `{ dcupdtls: { id, docName, ct, ty } }` (in maindocs /
   * suppdocs / docModel arrays) whose nesting varies by notice type, so we
   * deep-scan rather than assume a fixed path. Dedups by doc id.
   */
  _collectDocs(node, out, seen) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) this._collectDocs(x, out, seen); return; }
    const d = node.dcupdtls || ((node.id && node.docName) ? node : null);
    if (d && d.id && d.docName && !seen.has(String(d.id))) {
      seen.add(String(d.id));
      out.push({ docId: String(d.id), docName: d.docName, contentType: d.ct || null, docType: d.ty || null });
    }
    for (const k of Object.keys(node)) this._collectDocs(node[k], out, seen);
  }
}

module.exports = new GSTPortal();
