const sessionManager = require('./session-manager');
const captchaStore = require('./captcha-store');
const fs = require('fs');
const path = require('path');

const GST_LOGIN_URL = 'https://services.gst.gov.in/services/login';
const DOWNLOAD_TIMEOUT_MS = Number.parseInt(process.env.GST_DOWNLOAD_TIMEOUT_MS || '', 10)
  || (process.platform === 'linux' ? 60000 : 30000);
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
        return { error: 'Could not find direct GSTR-1 PDF button on the filed return page', pageButtons: pageState.controls };
      }
    }
    // Case 2: Non-nil return — click "VIEW SUMMARY" first
    else if (pageState.hasViewSummary) {
      // click View Summary — strictly match only this text
      const clickedSummary = await this._clickViewSummaryButton(activePage);
      if (!clickedSummary) {
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
        return { error: 'Could not find a download button on the GSTR-1 page', pageButtons: pageState.controls };
      }
    } else {
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

    return {
      filename: file,
      size: buffer.length,
      mimeType: 'application/pdf',
      base64: buffer.toString('base64'),
      downloadSource: clickResult.source,
    };
  }

  /**
   * View any filed return via: Services → Returns → View Filed Returns → fill form.
   * Captures all API calls and scrapes page data.
   */
  async viewReturn(sessionId, { financialYear, returnPeriod, filingPeriod, month, returnType }) {
    const session = sessionManager.getSession(sessionId);
    if (!session?.loggedIn) throw new Error('Not logged in');

    // start capturing APIs
    const capturedApis = [];
    const captureHandler = async (response) => {
      const url = response.url();
      try {
        const ct = response.headers()['content-type'] || '';
        if (ct.includes('json') || url.includes('/api/')) {
          const text = await response.text().catch(() => null);
          if (text) {
            let data;
            try { data = JSON.parse(text); } catch { data = text; }
            capturedApis.push({ url, method: response.request().method(), status: response.status(), data, timestamp: Date.now() });
          }
        }
      } catch (_) {}
    };
    session.page.on('response', captureHandler);

    // navigate via Services → Returns → View Filed Returns
    let activePage = await this._navigateToViewFiledReturns(session, {
      financialYear,
      returnPeriod,
      filingPeriod,
      month,
      returnType,
    });

    // also listen on new page if tab changed
    if (activePage !== session.page) {
      activePage.on('response', captureHandler);
    }

    // check for View Summary button (non-nil returns have this)
    const hasViewSummary = await activePage.evaluate(() => {
      return Array.from(document.querySelectorAll('button, a')).some(
        b => b.textContent.trim().toUpperCase().includes('VIEW SUMMARY')
      );
    });

    if (hasViewSummary) {
      await this._clickViewSummaryButton(activePage);
      await this._waitForPageSwitchOrUrlChange(session, activePage, activePage.url(), {
        targetUrlPart: '/returns/auth/gstr1',
        timeout: 8000,
      });
      await this._settlePortalPage(activePage, { timeout: 1200, fallbackMs: 80 });

      // check for new tab
      const latestPage = await this._getLatestActivePage(session, activePage);
      if (latestPage !== activePage) {
        activePage = latestPage;
        latestPage.on('response', captureHandler);
        await this._settlePortalPage(latestPage, { timeout: 1200, fallbackMs: 80 });
      }
    }

    if (this._normalizeReturnTypeKey(returnType) === 'GSTR3B') {
      await this._dismissGstr3bSummaryPopup(activePage);
      await this._settlePortalPage(activePage, { timeout: 1500, fallbackMs: 100 });
    }

    // scrape page content
    const pageData = await activePage.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('table')).map((t, i) => ({
        headers: Array.from(t.querySelectorAll('th')).map(th => th.textContent.trim()),
        rows: Array.from(t.querySelectorAll('tbody tr')).map(r =>
          Array.from(r.querySelectorAll('td')).map(td => td.textContent.trim())
        ),
      }));
      const title = document.title;
      const url = window.location.href;
      const bodyText = document.body.innerText.substring(0, 5000);
      return { title, url, tables, bodyText };
    });

    session.page.off('response', captureHandler);
    if (activePage !== session.page) activePage.off('response', captureHandler);

    return {
      returnType,
      financialYear,
      returnPeriod,
      pageData,
      capturedApis,
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
    return this.callPortalApi(
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
   * we can see where a headless flow got stuck. Never throws.
   */
  async _dumpDiag(session, page, label) {
    if (!process.env.GST_DEBUG) return; // opt-in; no-op in production
    try {
      const os = require('os');
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
          Array.from(document.querySelectorAll('button,a,input[type=button],input[type=submit]'))
            .filter((el) => el.offsetWidth || el.offsetHeight || el.getClientRects().length)
            .map((el) => (el.textContent || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 60))
            .filter(Boolean).slice(0, 60));
      } catch (_) {}
      try { await page.screenshot({ path: `${base}.png`, fullPage: true }); } catch (_) {}
      fs.writeFileSync(`${base}.json`, JSON.stringify(info, null, 2));
    } catch (_) { /* best-effort */ }
  }

  /**
   * Generic: call any internal portal API path.
   * If the URL targets services.gst.gov.in and we're not there, navigate via
   * clicking "Search Taxpayer" in the nav (GST blocks direct URL navigation
   * and pop-up tabs, so this single-tab approach is the only reliable path).
   */
  async callPortalApi(sessionId, urlOrPath, method = 'GET', body = null) {
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

  // ─── DOWNLOAD ─────────────────────────────────────────────────

  /**
   * Download a return file (Excel/JSON/PDF).
   * Uses "View Filed Returns" flow, then finds and clicks DOWNLOAD.
   */
  async downloadReturn(sessionId, { financialYear, returnPeriod, filingPeriod, month, returnType }) {
    if (this._normalizeReturnTypeKey(returnType) === 'GSTR3B') {
      return this.downloadGstr3bPdf(sessionId, {
        financialYear,
        returnPeriod,
        filingPeriod,
        month,
        returnType,
      });
    }

    const session = sessionManager.getSession(sessionId);
    if (!session?.loggedIn) throw new Error('Not logged in');

    const downloadDir = session.downloadDir;

    // clear any existing files in download dir
    const existingFiles = fs.readdirSync(downloadDir);
    for (const f of existingFiles) {
      fs.unlinkSync(path.join(downloadDir, f));
    }

    // navigate via Services → Returns → View Filed Returns
    const activePage = await this._navigateToViewFiledReturns(session, {
      financialYear,
      returnPeriod,
      filingPeriod,
      month,
      returnType,
    });

    // setup download behavior
    await sessionManager.setupDownloadForPage(sessionId, activePage);

    // check page state — might need View Summary first for non-nil returns
    const pageState = await activePage.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('button, a'));
      const texts = allEls.map(b => b.textContent.trim().toUpperCase());
      return {
        hasViewSummary: texts.some(t => t.includes('VIEW SUMMARY')),
        hasDownload: texts.some(t => t.includes('DOWNLOAD')),
        notFiled: document.body.innerText.toUpperCase().includes('NOT FILED') || document.body.innerText.toUpperCase().includes('NO RECORD FOUND'),
        texts: texts.slice(0, 30),
      };
    });

    if (pageState.notFiled) {
      return { error: 'Return not filed for this period', status: 'NOT_FILED' };
    }

    // If View Summary exists, click it first (non-nil return)
    if (pageState.hasViewSummary && !pageState.hasDownload) {
      await activePage.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button, a')).find(
          b => b.textContent.trim().toUpperCase().includes('VIEW SUMMARY')
        );
        if (btn) btn.click();
      });
      await this._waitForPageSwitchOrUrlChange(session, activePage, activePage.url(), {
        targetUrlPart: '/returns/auth/',
        timeout: 8000,
      });
      await this._settlePortalPage(activePage, { timeout: 1200, fallbackMs: 80 });
    }

    // click DOWNLOAD button
    const dlClicked = await activePage.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, a')).find(
        b => b.textContent.toUpperCase().includes('DOWNLOAD')
      );
      if (btn) { btn.click(); return true; }
      return false;
    });

    if (!dlClicked) {
      return { error: `Could not find DOWNLOAD button for ${returnType}`, pageButtons: pageState.texts };
    }

    // wait for download to complete
    const file = await this._waitForDownload(downloadDir, DOWNLOAD_TIMEOUT_MS);
    if (!file) {
      return { error: 'Download timed out — no file appeared' };
    }

    const filePath = path.join(downloadDir, file);
    const fileBuffer = fs.readFileSync(filePath);
    const base64 = fileBuffer.toString('base64');
    const ext = path.extname(file).toLowerCase();

    return {
      returnType,
      financialYear,
      returnPeriod,
      filename: file,
      mimeType: ext === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : ext === '.pdf' ? 'application/pdf'
        : ext === '.json' ? 'application/json'
        : ext === '.csv' ? 'text/csv'
        : 'application/octet-stream',
      size: fileBuffer.length,
      base64,
    };
  }

  /**
   * List all downloaded files for a session.
   */
  listDownloads(sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error('Invalid session');
    const files = fs.readdirSync(session.downloadDir);
    return files.map(f => {
      const stat = fs.statSync(path.join(session.downloadDir, f));
      return { filename: f, size: stat.size, modified: stat.mtime };
    });
  }

  /**
   * Get a specific downloaded file as base64.
   */
  getDownloadedFile(sessionId, filename) {
    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error('Invalid session');
    const filePath = path.join(session.downloadDir, filename);
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filename}`);
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filename).toLowerCase();
    return {
      filename,
      size: buffer.length,
      mimeType: ext === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : ext === '.pdf' ? 'application/pdf'
        : ext === '.json' ? 'application/json'
        : 'application/octet-stream',
      base64: buffer.toString('base64'),
    };
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

  async _returnsFetch(sessionId, path) {
    const session = sessionManager.getSession(sessionId);
    if (!session?.loggedIn) throw new Error('Not logged in');

    const page = session.page;
    return page.evaluate(async (path) => {
      try {
        const resp = await fetch(path, { credentials: 'include' });
        return await resp.json();
      } catch (e) {
        return { error: e.message };
      }
    }, path);
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

  async screenshot(sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error('Invalid session');
    const buffer = await session.page.screenshot({ encoding: 'base64', fullPage: true });
    return { screenshot: buffer };
  }

  getCapturedApis(sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error('Invalid session');
    return session.capturedApis || [];
  }
}

module.exports = new GSTPortal();
