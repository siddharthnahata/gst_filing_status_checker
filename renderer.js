'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  // shared
  endpoint:       null,
  apiKey:         null,
  activeUsername: null,
  activePassword: null,

  // Tab 1 — Filing Status
  sessionId:      null,
  inputRows:      [],
  results:        [],
  isRunning:      false,
  captchaResolve: null,
  captchaReject:  null,

  // Tab 2 — Download Return
  dlSessionId:      null,
  dlCaptchaResolve: null,
  dlCaptchaReject:  null,
  dlBulkRunning:    false,
  dlAccountId:      null,  // set when a saved account is selected; cleared on manual edit

  // Tab 3 — Notices
  ntcSessionId:      null,
  ntcCaptchaResolve: null,
  ntcCaptchaReject:  null,
  ntcAccountId:      null,  // set when a saved account is selected; cleared on manual edit
  ntcNotices:        [],    // last-fetched notices, keyed by id for download lookups
  ntcCaseDocsNoticeId: null, // notice id whose case-folder documents are shown in the modal
  ntcCaseDocsList:     [],   // documents currently listed in the case docs modal
};

// ── API key error helpers ─────────────────────────────────────────────────────
class ApiKeyError extends Error {
  constructor(msg) { super(msg); this.name = 'ApiKeyError'; }
}

function isApiKeyError(result) {
  if (result.httpStatus !== 401) return false;
  const errStr = String(result.data?.error || '').toLowerCase();
  return errStr.includes('invalid api key') || errStr.includes('api key required') || errStr.includes('x-api-key');
}

function throwIfApiKeyError(result) {
  if (isApiKeyError(result)) {
    throw new ApiKeyError('API authentication error — try restarting the app.');
  }
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');
const val  = id => $(id).value.trim();

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const prevBtn = document.querySelector('.tab-btn.active');
    if (prevBtn === btn) return;

    const tabs  = [...document.querySelectorAll('.tab-btn')];
    const dir   = tabs.indexOf(btn) > tabs.indexOf(prevBtn) ? 1 : -1;
    const prev  = $(prevBtn.dataset.tab);
    const next  = $(btn.dataset.tab);

    // Slide out current
    prev.style.transition = 'opacity 0.18s ease, transform 0.18s ease';
    prev.style.opacity    = '0';
    prev.style.transform  = `translateX(${dir * -28}px)`;
    prev.style.pointerEvents = 'none';

    // Position incoming panel off-screen
    next.style.transition = 'none';
    next.style.opacity    = '0';
    next.style.transform  = `translateX(${dir * 28}px)`;
    next.style.pointerEvents = 'none';
    next.offsetHeight; // force reflow

    // Slide in
    next.style.transition = 'opacity 0.18s ease, transform 0.18s ease';
    next.style.opacity    = '1';
    next.style.transform  = 'translateX(0)';
    next.style.pointerEvents = 'all';

    prevBtn.classList.remove('active');
    btn.classList.add('active');

    setTimeout(() => {
      for (const el of [prev, next]) {
        el.style.transition   = '';
        el.style.opacity      = '';
        el.style.transform    = '';
        el.style.pointerEvents = '';
      }
      prev.classList.remove('active');
      next.classList.add('active');
    }, 200);
  });
});

// ── Logging ───────────────────────────────────────────────────────────────────
function _makeLogLine(msg, level) {
  const now = new Date();
  const ts  = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  line.innerHTML = `<span class="ts">${ts}</span><span class="msg">${escHtml(msg)}</span>`;
  return line;
}

function addLog(msg, level = 'info') {
  const log = $('log');
  log.appendChild(_makeLogLine(msg, level));
  log.scrollTop = log.scrollHeight;
}

function addDlLog(msg, level = 'info') {
  const log = $('dlLog');
  log.appendChild(_makeLogLine(msg, level));
  log.scrollTop = log.scrollHeight;
}

// ── Status dot ────────────────────────────────────────────────────────────────
function setStatus(text, mode = '') {
  $('statusText').textContent = text;
  $('statusDot').className = 'status-dot' + (mode ? ` ${mode}` : '');
}

// ── Progress bar ──────────────────────────────────────────────────────────────
function setProgress(done, total, label) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const bar = $('progressBar');
  bar.style.width = `${pct}%`;
  bar.className   = 'progress-bar' + (done === total && total > 0 ? ' complete' : '');
  $('progressLabel').textContent = label || `${done} / ${total}`;
  $('progressPct').textContent   = total > 0 ? `${pct}%` : '';
}

// ── Financial year helpers ────────────────────────────────────────────────────
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// Return type classification
const ANNUAL_RETURN_TYPES    = new Set(['GSTR9', 'GSTR9C', 'GSTR4']);
const QUARTERLY_RETURN_TYPES = new Set(['GSTR1Q', 'CMP08']);
const QUARTER_END_MONTHS     = new Set(['June', 'September', 'December', 'March']);

function getFinancialYear(month, year) {
  const idx = MONTHS.indexOf(month) + 1;
  return idx >= 4 ? String(year) : String(year - 1);
}

function getDownloadFY(month, year) {
  const idx = MONTHS.indexOf(month) + 1;
  const fyStart = idx >= 4 ? year : year - 1;
  return `${fyStart}-${String(fyStart + 1).slice(2)}`;
}

function getReturnPeriod(month, year) {
  const mm = String(MONTHS.indexOf(month) + 1).padStart(2, '0');
  return `${mm}${year}`;
}

function updateFYDisplay() {
  const rt   = $('returnType').value;
  const month = $('month').value;
  const year  = parseInt($('year').value);
  if (!year) return;
  if (ANNUAL_RETURN_TYPES.has(rt)) {
    $('fyDisplay').textContent = `→ Annual Return · FY ${year}-${String(year + 1).slice(2)}`;
  } else {
    const fyStart = getFinancialYear(month, year);
    $('fyDisplay').textContent = `→ FY ${fyStart}-${String(parseInt(fyStart) + 1).slice(2)}`;
  }
}

// Lock / filter the month dropdown based on return type
function syncMonthToReturnType() {
  const rt      = $('returnType').value;
  const monthEl = $('month');
  const opts    = [...monthEl.options];

  if (ANNUAL_RETURN_TYPES.has(rt)) {
    // Annual: month irrelevant — fade and disable
    monthEl.disabled = true;
    monthEl.style.opacity = '0.35';
    opts.forEach(o => { o.disabled = false; o.style.display = ''; });
  } else if (QUARTERLY_RETURN_TYPES.has(rt)) {
    // Quarterly: only quarter-end months allowed
    monthEl.disabled = false;
    monthEl.style.opacity = '';
    opts.forEach(o => {
      const allowed = QUARTER_END_MONTHS.has(o.value);
      o.disabled    = !allowed;
      o.style.display = allowed ? '' : 'none';
    });
    // If current selection is not a quarter-end month, jump to June
    if (!QUARTER_END_MONTHS.has(monthEl.value)) monthEl.value = 'June';
  } else {
    // Monthly: all months available
    monthEl.disabled = false;
    monthEl.style.opacity = '';
    opts.forEach(o => { o.disabled = false; o.style.display = ''; });
  }
  updateFYDisplay();
}

function updateDlFYDisplay() {
  const month = $('dlMonth').value;
  const year  = parseInt($('dlYear').value);
  if (!year) return;
  const fy = getDownloadFY(month, year);
  $('dlFyDisplay').textContent = `→ Financial Year: ${fy}`;
}

// ── GSTIN validator ───────────────────────────────────────────────────────────
// 15 chars: 2-digit state + 5-letter PAN prefix + 4 digits + 1 letter + entity + Z + checksum
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function isValidGSTIN(gstin) {
  return typeof gstin === 'string' && gstin.length === 15 && GSTIN_RE.test(gstin);
}

// ── Period matching ───────────────────────────────────────────────────────────
const MONTH_NAMES = MONTHS.map(m => m.toLowerCase());
const MONTH_ABBR  = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const QUARTER_MONTHS = {
  q1: ['april','may','june'],
  q2: ['july','august','september'],
  q3: ['october','november','december'],
  q4: ['january','february','march'],
};

function matchesPeriod(taxp, targetMonth) {
  if (!taxp || !targetMonth) return false;
  const tp = taxp.trim().toLowerCase();
  const tm = targetMonth.trim().toLowerCase();

  if (tp === tm) return true;
  if (QUARTER_MONTHS[tp] && QUARTER_MONTHS[tp].includes(tm)) return true;

  const dashIdx = tp.indexOf('-');
  if (dashIdx > 0) {
    const startStr = tp.substring(0, dashIdx).trim();
    const endStr   = tp.substring(dashIdx + 1).trim();
    const startIdx = MONTH_NAMES.indexOf(startStr) !== -1 ? MONTH_NAMES.indexOf(startStr) : MONTH_ABBR.indexOf(startStr);
    const endIdx   = MONTH_NAMES.indexOf(endStr)   !== -1 ? MONTH_NAMES.indexOf(endStr)   : MONTH_ABBR.indexOf(endStr);
    const targetIdx = MONTH_NAMES.indexOf(tm);
    if (startIdx !== -1 && endIdx !== -1 && targetIdx !== -1) {
      return targetIdx >= startIdx && targetIdx <= endIdx;
    }
  }

  return false;
}

function findMatchingEntry(filingStatus, targetMonth, returnType) {
  if (!Array.isArray(filingStatus)) return null;
  const flat = filingStatus.flat(Infinity).filter(Boolean);

  // Annual returns use taxp: "Annual" — month is irrelevant
  // GSTR4 option maps to GSTR4X in the API (composition annual return)
  if (ANNUAL_RETURN_TYPES.has(returnType)) {
    const annualTypes = returnType === 'GSTR4' ? ['GSTR4', 'GSTR4X'] : [returnType];
    return flat.find(e =>
      annualTypes.includes(e.rtntype) &&
      (e.taxp || '').toLowerCase() === 'annual' &&
      e.status === 'Filed'
    ) || null;
  }

  // GSTR1 (monthly filers) + GSTR1FF (quarterly QRMP filers) — GSTR1 option covers both
  // GSTR1Q (quarterly-specific) — match only GSTR1FF
  const types = returnType === 'GSTR1'  ? ['GSTR1', 'GSTR1FF']
              : returnType === 'GSTR1Q' ? ['GSTR1FF']
              : [returnType];
  return flat.find(e =>
    types.includes(e.rtntype) && matchesPeriod(e.taxp, targetMonth) && e.status === 'Filed'
  ) || null;
}

// ── Session expiry detection ──────────────────────────────────────────────────
function isSessionExpiredResponse(result) {
  if (result.httpStatus === 401 && isApiKeyError(result)) return false;
  if (result.httpStatus === 401) return true;
  if (!result.ok && !result.data) return false;
  const str = JSON.stringify(result.data || result.error || '').toLowerCase();
  return str.includes('invalid session') || str.includes('session expired') ||
         str.includes('session invalid') || str.includes('please login again') ||
         str.includes('not logged in');
}

// ── Sleep ─────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
//  TAB 1 — FILING STATUS
// ─────────────────────────────────────────────────────────────────────────────

// ── Captcha controller factory ────────────────────────────────────────────────
// Tab 1 / Tab 2 / Tab 3 each drive an identical captcha modal flow (show →
// wait for submit/cancel/refresh → resolve/reject), differing only in the
// element-id prefix, which log function to use, an optional session-status
// callback on success, and (Tab 1 only) preferring the last-used login
// credentials over the current form fields when refreshing the captcha.
function pid(prefix, name) {
  const s = prefix + name;
  return prefix ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

function createCaptchaController(prefix, { log, onLoggedIn = () => {}, getCredentials } = {}) {
  const imgId       = pid(prefix, 'CaptchaImg');
  const inputId      = pid(prefix, 'CaptchaInput');
  const submitBtnId  = pid(prefix, 'CaptchaSubmitBtn');
  const refreshBtnId = pid(prefix, 'CaptchaRefreshBtn');
  const cancelBtnId  = pid(prefix, 'CaptchaCancelBtn');
  const errorId      = pid(prefix, 'CaptchaError');
  const sectionId    = pid(prefix, 'CaptchaSection');
  const usernameId   = pid(prefix, 'Username');
  const passwordId   = pid(prefix, 'Password');
  const sessionKey   = pid(prefix, 'SessionId');
  const resolveKey   = pid(prefix, 'CaptchaResolve');
  const rejectKey    = pid(prefix, 'CaptchaReject');

  const readCredentials = getCredentials || (() => ({
    username: val(usernameId),
    password: $(passwordId).value,
  }));

  function open(base64) {
    hide('manageAccountsModal'); // captcha must not be hidden behind an open modal
    hide('caseDocsModal');
    $(imgId).src = `data:image/png;base64,${base64}`;
    $(inputId).value = '';
    $(inputId).disabled = false;
    $(submitBtnId).disabled = false;
    $(errorId).classList.add('hidden');
    show(sectionId);
    // The login that triggers a captcha runs in the background, so the OS may
    // have moved focus elsewhere by the time it's ready — pull the window back
    // to the foreground so real keystrokes actually reach the input.
    window.gstApp.focusWindow?.();
    setTimeout(() => $(inputId).focus(), 100);
  }

  function close() {
    hide(sectionId);
    $(inputId).value = '';
  }

  function showError(msg) {
    const el = $(errorId);
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function openAndWait(base64) {
    open(base64);
    return new Promise((resolve, reject) => {
      state[resolveKey] = resolve;
      state[rejectKey]  = reject;
    });
  }

  async function refresh() {
    $(refreshBtnId).disabled = true;
    try {
      const { username, password } = readCredentials();
      const res = await window.gstApp.login({ endpoint: state.endpoint, apiKey: state.apiKey, username, password });
      if (isApiKeyError(res)) {
        const err = new ApiKeyError('API authentication error — try restarting the app.');
        showError(err.message);
        if (state[rejectKey]) { state[rejectKey](err); state[rejectKey] = null; }
        return;
      }
      if (res.ok && res.data.captchaBase64) {
        state[sessionKey] = res.data.sessionId;
        open(res.data.captchaBase64);
        log('Captcha refreshed.', 'info');
      }
    } catch (e) {
      log(`Refresh failed: ${e.message}`, 'error');
    } finally {
      $(refreshBtnId).disabled = false;
    }
  }

  function cancel() {
    close();
    if (state[rejectKey]) { state[rejectKey](new Error('Cancelled by user')); state[rejectKey] = null; }
  }

  async function submit() {
    const captcha = val(inputId);
    if (!captcha) { showError('Please enter the captcha.'); return; }

    $(inputId).disabled = true;
    $(submitBtnId).disabled = true;
    $(errorId).classList.add('hidden');

    const res = await window.gstApp.submitCaptcha({
      endpoint: state.endpoint, apiKey: state.apiKey, sessionId: state[sessionKey], captcha,
    });

    if (isApiKeyError(res)) {
      const err = new ApiKeyError('API authentication error — try restarting the app.');
      showError(err.message);
      if (state[rejectKey]) { state[rejectKey](err); state[rejectKey] = null; }
      return;
    }

    if (!res.ok) {
      showError(`Error: ${res.error || `HTTP ${res.httpStatus}`}`);
      $(inputId).disabled = false;
      $(submitBtnId).disabled = false;
      return;
    }

    const d = res.data;

    if (d.loggedIn) {
      state[sessionKey] = d.sessionId || state[sessionKey];
      const name = d.userInfo?.name || d.userInfo?.gstin || '';
      log(`Captcha verified — logged in${name ? ` as ${name}` : ''}.`, 'ok');
      window.gstApp.reportCaptcha({ captchaText: captcha, captchaBase64: $(imgId).src.split(',')[1] || $(imgId).src });
      close();
      onLoggedIn();
      if (state[resolveKey]) { state[resolveKey](); state[resolveKey] = null; }
      return;
    }

    if (d.needsCaptcha && d.captchaBase64) {
      const err = d.errorMessage || 'Incorrect captcha. Please try again.';
      log(err, 'warn');
      showError(err);
      open(d.captchaBase64);
      return;
    }

    showError(`Unexpected response: ${JSON.stringify(d)}`);
    $(inputId).disabled = false;
    $(submitBtnId).disabled = false;
  }

  $(submitBtnId).addEventListener('click', submit);
  $(inputId).addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  $(cancelBtnId).addEventListener('click', cancel);
  $(refreshBtnId).addEventListener('click', refresh);

  return { openAndWait, close };
}

// ── Tab 1 captcha ─────────────────────────────────────────────────────────────
const tab1Captcha = createCaptchaController('', {
  log: addLog,
  getCredentials: () => ({
    username: state.activeUsername || val('username'),
    password: state.activePassword || $('password').value,
  }),
});
function showCaptchaAndWait(base64) { return tab1Captcha.openAndWait(base64); }
function hideCaptcha() { tab1Captcha.close(); }

// ── Tab 1 login ───────────────────────────────────────────────────────────────
async function doLogin(username, password) {
  const endpoint = state.endpoint;
  const apiKey   = state.apiKey;
  const uname    = username !== undefined ? username : val('username');
  const pwd      = password !== undefined ? password : $('password').value;

  state.activeUsername = uname;
  state.activePassword = pwd;

  addLog(`Logging in as "${uname}"…`, 'step');
  const res = await window.gstApp.login({ endpoint, apiKey, username: uname, password: pwd });
  throwIfApiKeyError(res);

  if (!res.ok) throw new Error(`Login failed: ${res.error || `HTTP ${res.httpStatus}`}`);

  const d = res.data;
  state.sessionId = d.sessionId;

  if (d.loggedIn) {
    const name = d.userInfo?.name || d.userInfo?.gstin || '';
    addLog(`Logged in successfully${name ? ` — ${name}` : ''}.`, 'ok');
    return;
  }

  if (d.needsCaptcha && d.captchaBase64) {
    addLog('Captcha required — enter it on the right.', 'warn');
    await showCaptchaAndWait(d.captchaBase64);
    return;
  }

  throw new Error(`Unexpected login response: ${JSON.stringify(d)}`);
}

// ── Tab 1 re-authenticate mid-batch ──────────────────────────────────────────
async function reAuthenticate() {
  addLog('⚠ Session expired — re-authenticating…', 'warn');
  setStatus('Re-authenticating…', 'running');
  await doLogin(state.activeUsername, state.activePassword);
  setStatus('Running…', 'running');
}

// ── Batch processing ──────────────────────────────────────────────────────────
async function processSingleGSTIN(gstin, name, email, financialYear, targetMonth, returnType, retryCount = 0) {
  const res = await window.gstApp.checkFilingStatus({
    endpoint: state.endpoint,
    apiKey:   state.apiKey,
    sessionId: state.sessionId,
    gstin,
    financialYear,
  });

  throwIfApiKeyError(res);

  if (!res.ok) {
    if (retryCount < 1 && isSessionExpiredResponse(res)) {
      await reAuthenticate();
      return processSingleGSTIN(gstin, name, email, financialYear, targetMonth, returnType, retryCount + 1);
    }
    return { gstin, name, email, status: 'Error', dof: '', arn: '', note: res.error || `HTTP ${res.httpStatus}` };
  }

  if (retryCount < 1 && isSessionExpiredResponse(res)) {
    await reAuthenticate();
    return processSingleGSTIN(gstin, name, email, financialYear, targetMonth, returnType, retryCount + 1);
  }

  const d = res.data;
  const entry = findMatchingEntry(d.filingStatus, targetMonth, returnType);

  if (entry) {
    const note = entry.rtntype === 'GSTR1FF' ? 'Filed as GSTR1-FF (Quarterly)' : '';
    return { gstin, name, email, status: 'Filed', dof: entry.dof || '', arn: entry.arn || '', note };
  }

  const topStatus     = d.status || '';
  const hasAnyRecords = Array.isArray(d.filingStatus) && d.filingStatus.flat(Infinity).length > 0;
  const note = !hasAnyRecords && topStatus.toLowerCase().includes('no records') ? 'No records on portal' : '';
  return { gstin, name, email, status: 'Not Filed', dof: '', arn: '', note };
}

async function runBatch() {
  const rows          = state.inputRows;
  const total         = rows.length;
  const month         = $('month').value;
  const year          = parseInt($('year').value);
  const returnType    = $('returnType').value;
  const isAnnual      = ANNUAL_RETURN_TYPES.has(returnType);
  const financialYear = isAnnual ? String(year) : getFinancialYear(month, year);
  const targetMonth   = isAnnual ? 'Annual' : month;

  const defaultUsername = val('username');
  const defaultPassword = $('password').value;
  const hasPerRowCreds  = rows.some(r => r.username && r.password);

  // Build credential groups (preserving row order within each group)
  let groups;
  if (hasPerRowCreds) {
    const credMap = new Map();
    groups = [];
    for (const row of rows) {
      const u = row.username || defaultUsername;
      const p = row.password || defaultPassword;
      const key = `${u}\x00${p}`;
      if (!credMap.has(key)) {
        const grp = { username: u, password: p, rows: [] };
        credMap.set(key, grp);
        groups.push(grp);
      }
      credMap.get(key).rows.push(row);
    }
  } else {
    groups = [{ username: defaultUsername, password: defaultPassword, rows }];
  }

  const periodLabel = isAnnual ? `FY ${financialYear}-${String(parseInt(financialYear)+1).slice(2)}` : `${month} ${year} | FY ${financialYear}`;
  addLog(`─── Batch start: ${total} GSTINs | ${periodLabel} | ${returnType}${groups.length > 1 ? ` | ${groups.length} credential groups` : ''} ───`, 'step');

  let filed = 0, notFiled = 0, errored = 0, invalid = 0, seq = 0;
  const results = [];

  show('summaryCounts');
  updateSummaryCounts(0, 0, 0, 0, 0);

  for (let g = 0; g < groups.length; g++) {
    if (!state.isRunning) break;

    const group = groups[g];

    // Logout previous group's session before switching credentials
    if (g > 0 && state.sessionId) {
      try { await window.gstApp.logout({ endpoint: state.endpoint, apiKey: state.apiKey, sessionId: state.sessionId }); } catch (_) {}
      state.sessionId = null;
    }

    if (groups.length > 1) addLog(`─── Account ${g + 1}/${groups.length}: "${group.username}" (${group.rows.length} GSTINs) ───`, 'step');
    await doLogin(group.username, group.password);

    for (let i = 0; i < group.rows.length; i++) {
      if (!state.isRunning) { addLog('Run stopped by user.', 'warn'); break; }

      seq++;
      const { gstin, email, name = '' } = group.rows[i];
      setProgress(seq - 1, total, `Processing ${seq} / ${total}: ${gstin}`);

      if (!isValidGSTIN(gstin)) {
        invalid++;
        const result = { gstin, name, email, status: 'Invalid GSTIN', dof: '', arn: '', note: `Bad format (${gstin.length} chars)` };
        results.push(result);
        addLog(`[${seq}/${total}] ${gstin} → Invalid GSTIN — skipped`, 'warn');
        appendResultRow(results.length, result);
        updateSummaryCounts(filed, notFiled, errored, 0, invalid);
        continue;
      }

      let result;
      try {
        result = await processSingleGSTIN(gstin, name, email, financialYear, targetMonth, returnType);
      } catch (e) {
        if (e.name === 'ApiKeyError') throw e;
        result = { gstin, name, email, status: 'Error', dof: '', arn: '', note: e.message };
      }

      results.push(result);

      if (result.status === 'Filed')          { filed++;    addLog(`[${seq}/${total}] ${gstin} → Filed (${result.dof})${result.note ? ' — ' + result.note : ''}`, 'ok'); }
      else if (result.status === 'Not Filed') { notFiled++; addLog(`[${seq}/${total}] ${gstin} → Not Filed`, 'warn'); }
      else                                    { errored++;  addLog(`[${seq}/${total}] ${gstin} → Error: ${result.note}`, 'error'); }

      updateSummaryCounts(filed, notFiled, errored, 0, invalid);
      appendResultRow(results.length, result);

      if (i < group.rows.length - 1 && state.isRunning && seq % 50 === 0) {
        addLog(`Pausing 3s after ${seq} checks…`, 'info');
        await sleep(3000);
      }
    }
  }

  state.results = results;
  setProgress(total, total, `Done — ${total} processed`);
  addLog(`─── Batch complete: ${filed} Filed, ${notFiled} Not Filed, ${errored} Error(s) ───`, 'step');
  setStatus(`Done (${filed}✓ ${notFiled}✗)`, '');

  return { filed, notFiled, errored };
}

// ── Results table ─────────────────────────────────────────────────────────────
function appendResultRow(n, r) {
  show('resultsSection');
  const tr = document.createElement('tr');
  const badgeClass = r.status === 'Filed' ? 'filed' : r.status === 'Not Filed' ? 'notfiled' : r.status === 'Invalid GSTIN' ? 'invalid' : 'error';
  const icon = r.status === 'Filed' ? '✓' : r.status === 'Not Filed' ? '✗' : r.status === 'Invalid GSTIN' ? '⊘' : '⚠';
  tr.innerHTML = `
    <td>${n}</td>
    <td style="font-family:var(--fm);font-size:12px;">${escHtml(r.gstin)}</td>
    <td style="font-size:12px;">${escHtml(r.name || '')}</td>
    <td><span class="status-badge ${badgeClass}">${icon} ${escHtml(r.status)}</span></td>
    <td>${escHtml(r.dof)}</td>
    <td style="font-size:11px;">${escHtml(r.arn)}</td>
    <td style="font-size:11px;">${escHtml(r.email)}</td>
    <td style="font-size:11px;color:var(--text-muted);">${escHtml(r.note)}</td>
  `;
  $('resultsTbody').appendChild(tr);
}

function clearResultsTable() {
  $('resultsTbody').innerHTML = '';
  hide('resultsSection');
}

function updateSummaryCounts(filed, notFiled, errored, emailed, invalid = 0) {
  $('summaryCounts').innerHTML = `
    <span class="count-chip filed">✓ ${filed} Filed</span>
    <span class="count-chip notfiled">✗ ${notFiled} Not Filed</span>
    ${errored  ? `<span class="count-chip errored">⚠ ${errored} Error</span>`          : ''}
    ${invalid  ? `<span class="count-chip invalid">⊘ ${invalid} Invalid GSTIN</span>`  : ''}
    ${emailed  ? `<span class="count-chip emailed">✉ ${emailed} Emailed</span>`         : ''}
  `;
}

// ── Email defaulters ──────────────────────────────────────────────────────────
function substituteTemplate(tpl, gstin, period, returnType) {
  return (tpl || '')
    .replace(/\{gstin\}/gi,      gstin)
    .replace(/\{period\}/gi,     period)
    .replace(/\{returnType\}/gi, returnType);
}

function textToHtml(text) {
  return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

// ── Tab 2 — email the downloaded PDF to the client ────────────────────────────
// Never throws — a failure here must not abort the surrounding download flow,
// which still needs to offer the file for local saving either way.
async function emailDownloadedFile({ filename, base64, gstin, period, returnType }) {
  try {
    if (!$('dlEmailEnabled').checked) return;

    const to = val('dlEmailTo') || val('dlAccountEmail');
    if (!to) { addDlLog('⚠ Email enabled but no recipient address set — skipped.', 'warn'); return; }

    const smtpConfig = {
      host: val('dlSmtpHost'), port: val('dlSmtpPort'), secure: $('dlSmtpSecure').value,
      user: val('dlSmtpUser'), pass: $('dlSmtpPass').value, from: val('dlSmtpFrom'),
    };
    if (!smtpConfig.host || !smtpConfig.user || !smtpConfig.pass) {
      addDlLog('⚠ Email enabled but SMTP settings are incomplete — skipped.', 'warn');
      return;
    }

    const subject = substituteTemplate(val('dlEmailSubject') || 'Your {returnType} for {period}', gstin, period, returnType);
    const bodyTxt = substituteTemplate($('dlEmailBody').value || 'Please find attached your {returnType} for {period}.\nGSTIN: {gstin}', gstin, period, returnType);

    addDlLog(`Emailing ${filename} to ${to}…`, 'step');
    const res = await window.gstApp.sendEmail({
      smtpConfig, to, subject, text: bodyTxt, html: textToHtml(bodyTxt),
      attachments: [{ filename, base64 }],
    });
    if (res.ok) addDlLog(`✉ Emailed to ${to}`, 'ok');
    else        addDlLog(`✉ Email failed: ${res.error}`, 'error');
  } catch (e) {
    addDlLog(`✉ Email failed: ${e.message}`, 'error');
  }
}

function substituteNoticeTemplate(tpl, { gstin, noticeId, description }) {
  return (tpl || '')
    .replace(/\{gstin\}/gi,      gstin || '')
    .replace(/\{noticeId\}/gi,   noticeId || '')
    .replace(/\{description\}/gi, description || '');
}

// ── Tab 3 — preview-and-confirm email modal ───────────────────────────────────
let emailPreviewResolve = null;

function showEmailPreview({ to, subject, body, attachmentName }) {
  $('emailPreviewTo').textContent = to;
  $('emailPreviewSubject').textContent = subject;
  $('emailPreviewBody').textContent = body;
  $('emailPreviewAttachment').textContent = attachmentName;
  $('emailPreviewError').classList.add('hidden');
  show('emailPreviewModal');
  return new Promise((resolve) => { emailPreviewResolve = resolve; });
}

function resolveEmailPreview(sendIt) {
  hide('emailPreviewModal');
  if (emailPreviewResolve) { emailPreviewResolve(sendIt); emailPreviewResolve = null; }
}

$('emailPreviewSendBtn').addEventListener('click', () => resolveEmailPreview(true));
$('emailPreviewCancelBtn').addEventListener('click', () => resolveEmailPreview(false));
$('emailPreviewCloseBtn').addEventListener('click', () => resolveEmailPreview(false));
$('emailPreviewModal').addEventListener('click', (e) => {
  if (e.target.id === 'emailPreviewModal') resolveEmailPreview(false);
});

// ── Tab 3 — fetch a notice/case document, preview, and email it on confirm ───
// downloadFn: async () => { ok, base64, filename, error } — fetches the file
// (fresh or from cache). Never throws.
async function emailWithConfirm(downloadFn, { gstin, noticeId, description }) {
  addNtcLog('Preparing email…', 'step');
  let result;
  try {
    result = await downloadFn();
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  if (!result.ok) { addNtcLog(`Could not prepare email: ${result.error}`, 'error'); return; }

  const to = val('ntcEmailTo') || val('ntcAccountEmail');
  if (!to) { alert('No recipient email set. Enter one in "Send To" or save this account with an email address.'); return; }

  const smtpConfig = {
    host: val('ntcSmtpHost'), port: val('ntcSmtpPort'), secure: $('ntcSmtpSecure').value,
    user: val('ntcSmtpUser'), pass: $('ntcSmtpPass').value, from: val('ntcSmtpFrom'),
  };
  if (!smtpConfig.host || !smtpConfig.user || !smtpConfig.pass) {
    alert('SMTP settings are incomplete. Configure them in "Email Settings" first.');
    return;
  }

  const ctx = { gstin, noticeId, description };
  const subject = substituteNoticeTemplate(val('ntcEmailSubject') || 'GST Notice {noticeId}', ctx);
  const bodyTxt = substituteNoticeTemplate($('ntcEmailBody').value || 'Please find attached a document for notice {noticeId}.\n{description}\nGSTIN: {gstin}', ctx);

  const confirmed = await showEmailPreview({ to, subject, body: bodyTxt, attachmentName: result.filename });
  if (!confirmed) { addNtcLog('Email cancelled.', 'info'); return; }

  addNtcLog(`Emailing ${result.filename} to ${to}…`, 'step');
  try {
    const res = await window.gstApp.sendEmail({
      smtpConfig, to, subject, text: bodyTxt, html: textToHtml(bodyTxt),
      attachments: [{ filename: result.filename, base64: result.base64 }],
    });
    if (res.ok) addNtcLog(`✉ Emailed to ${to}`, 'ok');
    else        addNtcLog(`✉ Email failed: ${res.error}`, 'error');
  } catch (e) {
    addNtcLog(`✉ Email failed: ${e.message}`, 'error');
  }
}

async function sendEmails() {
  const smtpHost = val('smtpHost');
  const smtpUser = val('smtpUser');
  const smtpPass = $('smtpPass').value.trim();

  if (!smtpHost || !smtpUser || !smtpPass) {
    addLog('SMTP not fully configured — skipping email step.', 'warn');
    return 0;
  }

  const smtpConfig = {
    host: smtpHost,
    port: val('smtpPort') || '465',
    user: smtpUser,
    pass: smtpPass,
    from: val('smtpFrom') || smtpUser,
  };

  const month      = $('month').value;
  const year       = $('year').value;
  const returnType = $('returnType').value;
  const period     = `${month} ${year}`;

  const defaulters = state.results.filter(r => r.status === 'Not Filed' && r.email);
  if (defaulters.length === 0) {
    addLog('No "Not Filed" GSTINs have an email address — nothing to send.', 'info');
    return 0;
  }

  addLog(`Sending emails to ${defaulters.length} defaulter(s)…`, 'step');
  let sent = 0;

  for (const row of defaulters) {
    if (!state.isRunning) break;

    const subject  = substituteTemplate(val('emailSubject'), row.gstin, period, returnType);
    const bodyTxt  = substituteTemplate($('emailBody').value, row.gstin, period, returnType);

    const res = await window.gstApp.sendEmail({
      smtpConfig,
      to:      row.email,
      subject,
      text:    bodyTxt,
      html:    textToHtml(bodyTxt),
    });

    if (res.ok) { addLog(`✉ Sent → ${row.email} (${row.gstin})`, 'ok'); sent++; }
    else        { addLog(`✉ Failed → ${row.email} (${row.gstin}): ${res.error}`, 'error'); }

    await sleep(500);
  }

  addLog(`Email done: ${sent}/${defaulters.length} sent.`, sent === defaulters.length ? 'ok' : 'warn');
  return sent;
}

// ── Run button ────────────────────────────────────────────────────────────────
$('runBtn').addEventListener('click', async () => {
  if (!state.endpoint) { alert('Local API not ready. Please wait a moment and try again.'); return; }
  if (!state.inputRows.length) { alert('Select an input file with GSTINs first.'); return; }
  const hasPerRowCreds = state.inputRows.some(r => r.username && r.password);
  if ((!val('username') || !$('password').value) && !hasPerRowCreds) {
    alert('Enter your GST username and password, or load a file with per-row credentials.');
    return;
  }

  state.isRunning = true;
  state.results   = [];

  clearResultsTable();
  hide('summaryCounts');
  $('runBtn').disabled  = true;
  $('stopBtn').disabled = false;
  setStatus('Running…', 'running');
  setProgress(0, 0, 'Starting…');
  addLog('═══════════ Run started ═══════════', 'step');

  try {
    addLog(`Checking endpoint: ${state.endpoint}…`, 'step');
    const health = await window.gstApp.healthCheck({ endpoint: state.endpoint });
    if (!health.ok) throw new Error(`Cannot reach API — ${health.error || `HTTP ${health.httpStatus}`}`);
    addLog('Endpoint reachable.', 'ok');

    const { filed, notFiled, errored } = await runBatch();

    addLog('Batch complete. Use "Save Excel" to export results or "Send Emails" to notify defaulters.', 'ok');
    updateSummaryCounts(filed, notFiled, errored, 0);

  } catch (e) {
    addLog(`Fatal error: ${e.message}`, 'error');
    addLog('If this keeps happening, contact: siddharthnahata492@gmail.com', 'info');
    if (e.message !== 'Cancelled by user') {
      window.gstApp.logError({ message: e.message, context: `filing-status | ${$('month').value} ${$('year').value} | ${$('returnType').value}` });
    }
    setStatus('Error', 'error');
    hideCaptcha();
    if (state.captchaReject) { state.captchaReject(e); state.captchaReject = null; }
  } finally {
    state.isRunning       = false;
    $('runBtn').disabled  = false;
    $('stopBtn').disabled = true;
    if ($('statusDot').classList.contains('running')) setStatus('Done', '');
    saveCurrentConfig();
  }
});

$('stopBtn').addEventListener('click', () => {
  state.isRunning = false;
  addLog('Stop requested…', 'warn');
  $('stopBtn').disabled = true;
  if (state.captchaReject) { state.captchaReject(new Error('Stopped by user')); state.captchaReject = null; }
});

$('saveExcelBtn').addEventListener('click', async () => {
  if (!state.results.length) { alert('No results to save yet.'); return; }

  const month = $('month').value;
  const year  = $('year').value;
  const rt    = $('returnType').value;

  const excelData = state.results.map(r => ({
    'GSTIN':          r.gstin,
    'Name':           r.name  || '',
    'Status':         r.status,
    'Date of Filing': r.dof,
    'ARN':            r.arn,
    'Email':          r.email,
    'Note':           r.note,
  }));

  const defaultName = `GST_${rt}_${month}_${year}_${new Date().toISOString().slice(0,10)}.xlsx`;
  const res = await window.gstApp.saveExcel({ data: excelData, defaultName });
  if (res.canceled) return;
  if (res.ok) { addLog(`Excel saved: ${res.filePath}`, 'ok'); window.gstApp.openFile(res.filePath); }
  else        { addLog(`Failed to save Excel: ${res.error}`, 'error'); }
});

$('sendEmailBtn').addEventListener('click', async () => {
  if (!state.results.length) { alert('No results yet.'); return; }
  $('sendEmailBtn').disabled = true;
  state.isRunning = true;
  $('stopBtn').disabled = false;
  try {
    const sent      = await sendEmails();
    const filed     = state.results.filter(r => r.status === 'Filed').length;
    const notFiled  = state.results.filter(r => r.status === 'Not Filed').length;
    const errored   = state.results.filter(r => r.status === 'Error').length;
    updateSummaryCounts(filed, notFiled, errored, sent);
  } finally {
    state.isRunning            = false;
    $('sendEmailBtn').disabled = false;
    $('stopBtn').disabled      = true;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  TAB 2 — DOWNLOAD RETURN
// ─────────────────────────────────────────────────────────────────────────────

// ── Tab 2 session status ──────────────────────────────────────────────────────
function updateDlSessionStatus() {
  const el = $('dlSessionStatus');
  if (!el) return;
  if (state.dlSessionId) {
    el.textContent = '● Session active';
    el.className   = 'dl-session-status active';
  } else {
    el.textContent = '● No active session';
    el.className   = 'dl-session-status inactive';
  }
}

// ── Tab 2 captcha ─────────────────────────────────────────────────────────────
const dlCaptcha = createCaptchaController('dl', { log: addDlLog, onLoggedIn: updateDlSessionStatus });
function showDlCaptchaAndWait(base64) { return dlCaptcha.openAndWait(base64); }
function hideDlCaptcha() { dlCaptcha.close(); }

// ── Tab 2 login ───────────────────────────────────────────────────────────────
async function doDownloadLogin() {
  const endpoint = state.endpoint;
  const apiKey   = state.apiKey;
  const username = val('dlUsername');

  let password;
  if (state.dlAccountId) {
    const pwRes = await window.gstApp.getAccountPassword({ id: state.dlAccountId });
    if (!pwRes.ok) throw new Error('Could not decrypt saved password — please re-select the account or enter the password manually.');
    password = pwRes.password.trim();
  } else {
    password = $('dlPassword').value.trim();
  }

  if (!username || !password) throw new Error('Enter the client username and password first.');

  addDlLog(`Logging in as "${username}"…`, 'step');
  const res = await window.gstApp.login({ endpoint, apiKey, username, password });
  throwIfApiKeyError(res);

  if (!res.ok) throw new Error(`Login failed: ${res.error || `HTTP ${res.httpStatus}`}`);

  const d = res.data;
  state.dlSessionId = d.sessionId;

  if (d.loggedIn) {
    const name = d.userInfo?.name || d.userInfo?.gstin || '';
    addDlLog(`Logged in successfully${name ? ` — ${name}` : ''}.`, 'ok');
    updateDlSessionStatus();
    return;
  }

  if (d.needsCaptcha && d.captchaBase64) {
    addDlLog('Captcha required — enter it on the right.', 'warn');
    await showDlCaptchaAndWait(d.captchaBase64);
    updateDlSessionStatus();
    return;
  }

  throw new Error(`Unexpected login response: ${JSON.stringify(d)}`);
}


// ── Login & Download button ───────────────────────────────────────────────────
$('dlLoginDownloadBtn').addEventListener('click', async () => {
  if (!state.endpoint) { alert('Local API not ready. Please wait a moment and try again.'); return; }

  $('dlLoginDownloadBtn').disabled = true;
  $('dlLogoutBtn').disabled        = true;

  const statusEl = $('dlStatus');

  try {
    // Login if no active session
    if (!state.dlSessionId) {
      if (!val('dlUsername') || !$('dlPassword').value) {
        alert('Enter the client username and password first.');
        return;
      }

      addDlLog(`Checking endpoint…`, 'step');
      const health = await window.gstApp.healthCheck({ endpoint: state.endpoint });
      if (!health.ok) throw new Error(`Cannot reach API — ${health.error || `HTTP ${health.httpStatus}`}`);

      await doDownloadLogin();
    }

    // Download
    const returnType    = $('dlReturnType').value;
    const month         = $('dlMonth').value;
    const year          = parseInt($('dlYear').value);
    const financialYear = getDownloadFY(month, year);
    const returnPeriod  = getReturnPeriod(month, year);
    const periodLabel   = `${month} ${year}`;
    const forceRefresh  = $('dlForceRefresh').checked;

    addDlLog(`Downloading ${returnType} for ${periodLabel} (FY ${financialYear}, period ${returnPeriod})…`, 'step');
    statusEl.textContent = `Requesting ${returnType} PDF for ${periodLabel}…`;
    statusEl.className   = 'dl-status pending';
    show('dlStatus');

    let res = await window.gstApp.downloadPdf({
      endpoint:     state.endpoint,
      apiKey:       state.apiKey,
      sessionId:    state.dlSessionId,
      returnType,
      financialYear,
      returnPeriod,
      forceRefresh,
    });

    throwIfApiKeyError(res);

    // One-shot re-auth on session expiry
    if (!res.ok && isSessionExpiredResponse(res)) {
      addDlLog('Session expired — re-authenticating…', 'warn');
      state.dlSessionId = null;
      updateDlSessionStatus();
      await doDownloadLogin();
      res = await window.gstApp.downloadPdf({
        endpoint: state.endpoint, apiKey: state.apiKey,
        sessionId: state.dlSessionId, returnType, financialYear, returnPeriod, forceRefresh,
      });
      throwIfApiKeyError(res);
    }

    const d = res.data || {};

    if (d.status === 'NOT_FILED') {
      const served = d.servedPeriod ? ` (portal served period ${d.servedPeriod})` : '';
      const msg = `Not filed for ${periodLabel}${served}`;
      addDlLog(msg, 'warn');
      statusEl.textContent = `⚠ ${msg}`;
      statusEl.className   = 'dl-status notfiled';
      return;
    }

    if (!d.base64) {
      const errMsg = d.error || d.message || (res.ok ? 'No PDF data in response' : `HTTP ${res.httpStatus}`);
      addDlLog(`Download error: ${errMsg}`, 'error');
      statusEl.textContent = `✗ ${errMsg}`;
      statusEl.className   = 'dl-status error';
      return;
    }

    const dlFilename = d.filename || `${returnType}_${returnPeriod}.pdf`;
    await emailDownloadedFile({
      filename: dlFilename, base64: d.base64,
      gstin: val('dlAccountGstin'), period: periodLabel, returnType,
    });

    const saveRes = await window.gstApp.savePdf({
      base64:      d.base64,
      defaultName: dlFilename,
    });

    if (saveRes.canceled) {
      statusEl.textContent = 'Save cancelled.';
      statusEl.className   = 'dl-status';
      return;
    }

    if (saveRes.ok) {
      const sizeKb = d.size ? Math.round(d.size / 1024) : Math.round(d.base64.length * 0.75 / 1024);
      const cacheNote = d.cached ? ' (from cache)' : '';
      addDlLog(`✓ Saved: ${saveRes.filePath} (${sizeKb} KB)${cacheNote}`, 'ok');
      statusEl.textContent = `✓ Saved ${d.filename || 'return.pdf'} (${sizeKb} KB)${cacheNote}`;
      statusEl.className   = 'dl-status ok';
      window.gstApp.openFile(saveRes.filePath);
    } else {
      throw new Error(saveRes.error);
    }

  } catch (e) {
    if (e.name === 'ApiKeyError') {
      addDlLog(e.message, 'error');
    } else {
      addDlLog(`Error: ${e.message}`, 'error');
    }
    addDlLog('If this keeps happening, contact: siddharthnahata492@gmail.com', 'info');
    if (e.message !== 'Cancelled by user') {
      window.gstApp.logError({ message: e.message, context: `download | ${$('dlReturnType').value} | ${$('dlMonth').value} ${$('dlYear').value}` });
    }
    statusEl.textContent = `✗ ${e.message}`;
    statusEl.className   = 'dl-status error';
    show('dlStatus');
    hideDlCaptcha();
    if (state.dlCaptchaReject) { state.dlCaptchaReject(e); state.dlCaptchaReject = null; }
  } finally {
    $('dlLoginDownloadBtn').disabled = false;
    $('dlLogoutBtn').disabled        = false;
    updateDlSessionStatus();
  }
});

// ── Bulk download helpers ─────────────────────────────────────────────────────
function getMonthRange(startMonth, startYear, endMonth, endYear) {
  const periods = [];
  let m = MONTHS.indexOf(startMonth);
  let y = startYear;
  const eM = MONTHS.indexOf(endMonth);
  const eY  = endYear;
  if (y > eY || (y === eY && m > eM)) return periods; // invalid range
  while (y < eY || (y === eY && m <= eM)) {
    periods.push({ month: MONTHS[m], year: y });
    m++;
    if (m >= 12) { m = 0; y++; }
  }
  return periods;
}

function setBulkProgress(done, total, label) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const bar  = $('dlBulkProgressBar');
  bar.style.width = `${pct}%`;
  bar.className   = 'progress-bar' + (done === total && total > 0 ? ' complete' : '');
  $('dlBulkProgressLabel').textContent = label || `${done} / ${total}`;
  $('dlBulkProgressPct').textContent   = total > 0 ? `${pct}%` : '';
}

function updateBulkCounts(downloaded, notFiled, failed) {
  $('dlBulkCounts').innerHTML = `
    <span class="count-chip filed">✓ ${downloaded} Downloaded</span>
    <span class="count-chip notfiled">✗ ${notFiled} Not Filed</span>
    ${failed ? `<span class="count-chip errored">⚠ ${failed} Failed</span>` : ''}
  `;
}

// ── Bulk Download button ──────────────────────────────────────────────────────
$('dlBulkDownloadBtn').addEventListener('click', async () => {
  if (!state.endpoint) { alert('Local API not ready. Please wait a moment and try again.'); return; }

  const startMonth = $('dlBulkStartMonth').value;
  const startYear  = parseInt($('dlBulkStartYear').value);
  const endMonth   = $('dlBulkEndMonth').value;
  const endYear    = parseInt($('dlBulkEndYear').value);
  const returnType   = $('dlBulkReturnType').value;
  const forceRefresh = $('dlBulkForceRefresh').checked;

  const periods = getMonthRange(startMonth, startYear, endMonth, endYear);
  if (!periods.length) { alert('Invalid date range — "From" must be before or equal to "To".'); return; }

  state.dlBulkRunning = true;

  $('dlBulkDownloadBtn').disabled = true;
  $('dlLoginDownloadBtn').disabled = true;
  $('dlLogoutBtn').disabled = true;
  $('dlBulkStopBtn').disabled = false;

  show('dlBulkProgressCard');
  setBulkProgress(0, periods.length, `0 / ${periods.length} — Starting…`);
  updateBulkCounts(0, 0, 0);
  addDlLog(`─── Bulk download: ${periods.length} periods | ${returnType} ───`, 'step');

  try {
    // Login if needed
    if (!state.dlSessionId) {
      if (!val('dlUsername') || !$('dlPassword').value) {
        alert('Enter the client username and password first.');
        return;
      }
      addDlLog('Checking endpoint…', 'step');
      const health = await window.gstApp.healthCheck({ endpoint: state.endpoint });
      if (!health.ok) throw new Error(`Cannot reach API — ${health.error || `HTTP ${health.httpStatus}`}`);
      await doDownloadLogin();
    }

    const collected = [];
    let downloaded = 0, notFiled = 0, failed = 0;

    for (let i = 0; i < periods.length; i++) {
      if (!state.dlBulkRunning) { addDlLog('Bulk download stopped by user.', 'warn'); break; }

      const { month, year } = periods[i];
      const financialYear   = getDownloadFY(month, year);
      const returnPeriod    = getReturnPeriod(month, year);
      const periodLabel     = `${month} ${year}`;
      const monthAbbr       = month.slice(0, 3);

      setBulkProgress(i, periods.length, `${i + 1} / ${periods.length} — ${periodLabel}`);
      addDlLog(`[${i+1}/${periods.length}] ${returnType} ${periodLabel}…`, 'info');

      let res = await window.gstApp.downloadPdf({
        endpoint: state.endpoint, apiKey: state.apiKey,
        sessionId: state.dlSessionId, returnType, financialYear, returnPeriod, forceRefresh,
      });

      throwIfApiKeyError(res);

      // One-shot re-auth on session expiry
      if (!res.ok && isSessionExpiredResponse(res)) {
        addDlLog('Session expired — re-authenticating…', 'warn');
        state.dlSessionId = null;
        updateDlSessionStatus();
        await doDownloadLogin();
        res = await window.gstApp.downloadPdf({
          endpoint: state.endpoint, apiKey: state.apiKey,
          sessionId: state.dlSessionId, returnType, financialYear, returnPeriod, forceRefresh,
        });
        throwIfApiKeyError(res);
      }

      const d = res.data || {};

      if (d.status === 'NOT_FILED') {
        notFiled++;
        addDlLog(`  → Not filed`, 'warn');
      } else if (d.base64) {
        const filename = d.filename || `${returnType}_${monthAbbr}${year}.pdf`;
        collected.push({ name: filename, base64: d.base64 });
        downloaded++;
        const cacheNote = d.cached ? ' (cached)' : '';
        const kb = Math.round(d.base64.length * 0.75 / 1024);
        addDlLog(`  → ✓ ${filename} (${kb} KB)${cacheNote}`, 'ok');
      } else {
        failed++;
        addDlLog(`  → Error: ${d.error || d.message || `HTTP ${res.httpStatus}`}`, 'error');
      }

      updateBulkCounts(downloaded, notFiled, failed);

      // 1–2 s polite delay between requests (skip after last)
      if (i < periods.length - 1 && state.dlBulkRunning) {
        await sleep(1000 + Math.random() * 1000);
      }
    }

    setBulkProgress(periods.length, periods.length, `Done — ${periods.length} processed`);
    addDlLog(`─── Bulk complete: ${downloaded} downloaded, ${notFiled} not filed, ${failed} failed ───`, 'step');

    if (collected.length === 0) {
      addDlLog('No PDFs to save.', 'warn');
      return;
    }

    const defaultName = `${returnType}_${startMonth.slice(0,3)}${startYear}_to_${endMonth.slice(0,3)}${endYear}.zip`;
    addDlLog(`Creating ZIP with ${collected.length} file(s)…`, 'step');

    const saveRes = await window.gstApp.saveZip({ files: collected, defaultName });
    if (saveRes.canceled) { addDlLog('Save cancelled.', 'warn'); return; }
    if (saveRes.ok) {
      addDlLog(`✓ ZIP saved: ${saveRes.filePath} (${saveRes.count} files)`, 'ok');
      window.gstApp.openFile(saveRes.filePath);
      if (saveRes.zipBase64) {
        await emailDownloadedFile({
          filename: defaultName, base64: saveRes.zipBase64,
          gstin: val('dlAccountGstin'), period: `${startMonth} ${startYear} to ${endMonth} ${endYear}`, returnType,
        });
      }
    } else {
      throw new Error(saveRes.error);
    }

  } catch (e) {
    if (e.name === 'ApiKeyError') addDlLog(e.message, 'error');
    else addDlLog(`Error: ${e.message}`, 'error');
    addDlLog('If this keeps happening, contact: siddharthnahata492@gmail.com', 'info');
    if (e.message !== 'Cancelled by user') {
      window.gstApp.logError({ message: e.message, context: `bulk-download | ${$('dlBulkReturnType').value}` });
    }
    hideDlCaptcha();
    if (state.dlCaptchaReject) { state.dlCaptchaReject(e); state.dlCaptchaReject = null; }
  } finally {
    state.dlBulkRunning = false;
    $('dlBulkDownloadBtn').disabled  = false;
    $('dlLoginDownloadBtn').disabled = false;
    $('dlLogoutBtn').disabled        = false;
    $('dlBulkStopBtn').disabled      = true;
    updateDlSessionStatus();
  }
});

$('dlBulkStopBtn').addEventListener('click', () => {
  state.dlBulkRunning = false;
  addDlLog('Stop requested…', 'warn');
  $('dlBulkStopBtn').disabled = true;
  if (state.dlCaptchaReject) { state.dlCaptchaReject(new Error('Stopped by user')); state.dlCaptchaReject = null; }
});

// ── Logout (Tab 2) ────────────────────────────────────────────────────────────
$('dlLogoutBtn').addEventListener('click', async () => {
  if (!state.dlSessionId) { updateDlSessionStatus(); return; }
  $('dlLogoutBtn').disabled = true;
  try {
    await window.gstApp.logout({ endpoint: state.endpoint, apiKey: state.apiKey, sessionId: state.dlSessionId });
    state.dlSessionId = null;
    addDlLog('Logged out of client GST session.', 'info');
  } catch (_) {
    state.dlSessionId = null;
  } finally {
    updateDlSessionStatus();
    $('dlLogoutBtn').disabled = false;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  TAB 3 — NOTICES
// ─────────────────────────────────────────────────────────────────────────────

// ── Tab 3 logging ─────────────────────────────────────────────────────────────
function addNtcLog(msg, level = 'info') {
  const log = $('ntcLog');
  log.appendChild(_makeLogLine(msg, level));
  log.scrollTop = log.scrollHeight;
}

// ── Tab 3 session status ──────────────────────────────────────────────────────
function updateNtcSessionStatus() {
  const el = $('ntcSessionStatus');
  if (!el) return;
  if (state.ntcSessionId) {
    el.textContent = '● Session active';
    el.className   = 'dl-session-status active';
  } else {
    el.textContent = '● No active session';
    el.className   = 'dl-session-status inactive';
  }
}

// ── Tab 3 captcha ─────────────────────────────────────────────────────────────
const ntcCaptcha = createCaptchaController('ntc', { log: addNtcLog, onLoggedIn: updateNtcSessionStatus });
function showNtcCaptchaAndWait(base64) { return ntcCaptcha.openAndWait(base64); }
function hideNtcCaptcha() { ntcCaptcha.close(); }

// ── Tab 3 login ───────────────────────────────────────────────────────────────
async function doNtcLogin() {
  const endpoint = state.endpoint;
  const apiKey   = state.apiKey;
  const username = val('ntcUsername');

  let password;
  if (state.ntcAccountId) {
    const pwRes = await window.gstApp.getAccountPassword({ id: state.ntcAccountId });
    if (!pwRes.ok) throw new Error('Could not decrypt saved password — please re-select the account or enter the password manually.');
    password = pwRes.password.trim();
  } else {
    password = $('ntcPassword').value.trim();
  }

  if (!username || !password) throw new Error('Enter the client username and password first.');

  addNtcLog(`Logging in as "${username}"…`, 'step');
  const res = await window.gstApp.login({ endpoint, apiKey, username, password });
  throwIfApiKeyError(res);

  if (!res.ok) throw new Error(`Login failed: ${res.error || `HTTP ${res.httpStatus}`}`);

  const d = res.data;
  state.ntcSessionId = d.sessionId;

  if (d.loggedIn) {
    const name = d.userInfo?.name || d.userInfo?.gstin || '';
    addNtcLog(`Logged in successfully${name ? ` — ${name}` : ''}.`, 'ok');
    updateNtcSessionStatus();
    return;
  }

  if (d.needsCaptcha && d.captchaBase64) {
    addNtcLog('Captcha required — enter it on the right.', 'warn');
    await showNtcCaptchaAndWait(d.captchaBase64);
    updateNtcSessionStatus();
    return;
  }

  throw new Error(`Unexpected login response: ${JSON.stringify(d)}`);
}

// ── Notices table rendering ───────────────────────────────────────────────────
function renderNoticesTable(notices) {
  state.ntcNotices = notices;
  const tbody = $('noticesTbody');
  tbody.innerHTML = '';
  for (const n of notices) {
    const tr = document.createElement('tr');
    let actionHtml = '<span class="text-muted" style="font-size:11px;">—</span>';
    if (n.source === 'order') {
      actionHtml = `<button class="btn-xs btn-secondary ntc-download-order" data-id="${escHtml(n.id)}">↓ Download</button>
        <button class="btn-xs btn-secondary ntc-email-order" data-id="${escHtml(n.id)}" title="Email this document">✉</button>`;
    } else if (n.source === 'case') {
      actionHtml = `<button class="btn-xs btn-secondary ntc-view-case" data-id="${escHtml(n.id)}">📁 View Documents</button>
        <button class="btn-xs btn-secondary ntc-ai-summary" data-id="${escHtml(n.id)}" title="AI Summary">✨</button>`;
    }
    tr.innerHTML = `
      <td style="font-family:var(--fm);font-size:11px;">${escHtml(n.id)}</td>
      <td style="font-size:11px;">${escHtml(n.type || '—')}</td>
      <td style="font-size:11px;">${escHtml(n.description || '—')}</td>
      <td style="font-size:11px;">${escHtml(n.dateOfIssue || '—')}</td>
      <td style="font-size:11px;">${escHtml(n.dueDate || '—')}</td>
      <td style="font-size:11px;">${escHtml(n.status || '—')}</td>
      <td style="font-family:var(--fm);font-size:11px;">${escHtml(n.arn || '—')}</td>
      <td>${actionHtml}</td>
    `;
    tbody.appendChild(tr);
  }
  show('noticesSection');
}

$('noticesTbody').addEventListener('click', async (e) => {
  const downloadBtn = e.target.closest('.ntc-download-order');
  const viewBtn     = e.target.closest('.ntc-view-case');
  const aiBtn       = e.target.closest('.ntc-ai-summary');

  if (downloadBtn) {
    const notice = state.ntcNotices.find(n => n.id === downloadBtn.dataset.id);
    if (!notice) return;
    downloadBtn.disabled = true;
    const origText = downloadBtn.textContent;
    downloadBtn.textContent = 'Downloading…';
    try {
      const res = await window.gstApp.downloadOrderNotice({
        endpoint: state.endpoint, apiKey: state.apiKey, sessionId: state.ntcSessionId,
        docId: notice.refs?.docId, applnId: notice.refs?.applnId,
      });
      throwIfApiKeyError(res);
      if (!res.ok || !res.data?.base64) throw new Error(res.error || res.data?.error || `HTTP ${res.httpStatus}`);
      const defaultName = `notice_${notice.id}.pdf`;
      const saveRes = await window.gstApp.saveNoticeFile({ base64: res.data.base64, defaultName });
      if (saveRes.canceled) { addNtcLog('Save cancelled.', 'info'); return; }
      if (saveRes.ok) {
        addNtcLog(`✓ Saved: ${saveRes.filePath}`, 'ok');
        window.gstApp.openFile(saveRes.filePath);
      } else {
        throw new Error(saveRes.error);
      }
    } catch (err) {
      addNtcLog(`Download failed: ${err.message}`, 'error');
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = origText;
    }
    return;
  }

  const emailBtn = e.target.closest('.ntc-email-order');
  if (emailBtn) {
    const notice = state.ntcNotices.find(n => n.id === emailBtn.dataset.id);
    if (!notice) return;
    emailBtn.disabled = true;
    try {
      await emailWithConfirm(async () => {
        const res = await window.gstApp.downloadOrderNotice({
          endpoint: state.endpoint, apiKey: state.apiKey, sessionId: state.ntcSessionId,
          docId: notice.refs?.docId, applnId: notice.refs?.applnId,
        });
        throwIfApiKeyError(res);
        if (!res.ok || !res.data?.base64) return { ok: false, error: res.error || res.data?.error || `HTTP ${res.httpStatus}` };
        return { ok: true, base64: res.data.base64, filename: `notice_${notice.id}.pdf` };
      }, { gstin: val('ntcAccountGstin'), noticeId: notice.id, description: notice.description });
    } finally {
      emailBtn.disabled = false;
    }
    return;
  }

  if (viewBtn) {
    const notice = state.ntcNotices.find(n => n.id === viewBtn.dataset.id);
    if (!notice) return;
    viewBtn.disabled = true;
    const origText = viewBtn.textContent;
    viewBtn.textContent = 'Loading…';
    try {
      const res = await window.gstApp.getCaseDocuments({
        endpoint: state.endpoint, apiKey: state.apiKey, sessionId: state.ntcSessionId,
        caseId: notice.refs?.caseId, arn: notice.arn, caseTypeCd: notice.refs?.caseTypeCd,
      });
      throwIfApiKeyError(res);
      if (!res.ok) throw new Error(res.error || `HTTP ${res.httpStatus}`);
      openCaseDocsModal(notice, res.data?.documents || []);
    } catch (err) {
      addNtcLog(`Could not list case documents: ${err.message}`, 'error');
    } finally {
      viewBtn.disabled = false;
      viewBtn.textContent = origText;
    }
    return;
  }

  if (aiBtn) {
    const notice = state.ntcNotices.find(n => n.id === aiBtn.dataset.id);
    if (!notice) return;
    aiBtn.disabled = true;
    const origText = aiBtn.textContent;
    aiBtn.textContent = '…';
    try {
      const res = await window.gstApp.getCaseDocuments({
        endpoint: state.endpoint, apiKey: state.apiKey, sessionId: state.ntcSessionId,
        caseId: notice.refs?.caseId, arn: notice.arn, caseTypeCd: notice.refs?.caseTypeCd,
      });
      throwIfApiKeyError(res);
      if (!res.ok) throw new Error(res.error || `HTTP ${res.httpStatus}`);
      await openAiSummaryModal(notice, res.data?.documents || []);
    } catch (err) {
      addNtcLog(`Could not list case documents: ${err.message}`, 'error');
    } finally {
      aiBtn.disabled = false;
      aiBtn.textContent = origText;
    }
  }
});

// ── Case documents modal ──────────────────────────────────────────────────────
function openCaseDocsModal(notice, documents) {
  state.ntcCaseDocsNoticeId = notice.id;
  state.ntcCaseDocsList     = documents;
  $('caseDocsTitle').textContent = `📁 Case Documents — ${notice.id}`;
  const tbody = $('caseDocsTbody');
  tbody.innerHTML = '';
  for (const d of documents) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-size:11px;">${escHtml(d.docName)}</td>
      <td style="font-size:11px;">${escHtml(d.contentType || d.docType || '—')}</td>
      <td>
        <button class="btn-xs btn-secondary case-doc-download" data-notice-id="${escHtml(notice.id)}" data-doc-name="${escHtml(d.docName)}" data-folder="${escHtml(d.folder || '')}">↓ Download</button>
        <button class="btn-xs btn-secondary case-doc-email" data-notice-id="${escHtml(notice.id)}" data-doc-name="${escHtml(d.docName)}" data-folder="${escHtml(d.folder || '')}" title="Email this document">✉</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
  $('caseDocsEmpty').classList.toggle('hidden', documents.length > 0);
  $('caseDocsDownloadAllBtn').disabled = documents.length === 0;
  show('caseDocsModal');
}

// Fetch one case document's base64 payload. Returns { ok, base64, filename, error }.
async function fetchCaseDocument(noticeId, docName, folder) {
  try {
    const res = await window.gstApp.downloadCaseDocument({
      endpoint: state.endpoint, apiKey: state.apiKey, sessionId: state.ntcSessionId,
      id: noticeId, docName, folder,
    });
    throwIfApiKeyError(res);
    if (!res.ok || !res.data?.base64) throw new Error(res.error || res.data?.error || `HTTP ${res.httpStatus}`);
    return { ok: true, base64: res.data.base64, filename: res.data.filename || docName };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

$('caseDocsCloseBtn').addEventListener('click', () => hide('caseDocsModal'));
$('caseDocsModal').addEventListener('click', (e) => {
  if (e.target.id === 'caseDocsModal') hide('caseDocsModal');
});
$('caseDocsTbody').addEventListener('click', async (e) => {
  const downloadBtn = e.target.closest('.case-doc-download');
  const emailBtn    = e.target.closest('.case-doc-email');

  if (downloadBtn) {
    const { noticeId, docName, folder } = downloadBtn.dataset;
    downloadBtn.disabled = true;
    const origText = downloadBtn.textContent;
    downloadBtn.textContent = 'Downloading…';
    try {
      const result = await fetchCaseDocument(noticeId, docName, folder);
      if (!result.ok) throw new Error(result.error);
      const saveRes = await window.gstApp.saveNoticeFile({ base64: result.base64, defaultName: result.filename });
      if (saveRes.canceled) { addNtcLog('Save cancelled.', 'info'); return; }
      if (saveRes.ok) {
        addNtcLog(`✓ Saved: ${saveRes.filePath}`, 'ok');
        window.gstApp.openFile(saveRes.filePath);
      } else {
        throw new Error(saveRes.error);
      }
    } catch (err) {
      addNtcLog(`Document download failed: ${err.message}`, 'error');
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = origText;
    }
    return;
  }

  if (emailBtn) {
    const { noticeId, docName, folder } = emailBtn.dataset;
    emailBtn.disabled = true;
    try {
      const notice = state.ntcNotices.find(n => n.id === noticeId);
      await emailWithConfirm(
        () => fetchCaseDocument(noticeId, docName, folder),
        { gstin: val('ntcAccountGstin'), noticeId, description: notice?.description },
      );
    } finally {
      emailBtn.disabled = false;
    }
  }
});

// Downloads every listed case document in sequence. Returns the successfully
// fetched files (for zipping) and a count of any that failed along the way.
async function downloadAllCaseDocs(noticeId, documents, onProgress) {
  const files = [];
  let failed = 0;
  for (let i = 0; i < documents.length; i++) {
    const d = documents[i];
    if (onProgress) onProgress(i, documents.length);
    addNtcLog(`Downloading "${d.docName}" (${i + 1}/${documents.length})…`, 'step');
    const result = await fetchCaseDocument(noticeId, d.docName, d.folder);
    if (result.ok) {
      files.push({ name: result.filename, base64: result.base64 });
    } else {
      failed++;
      addNtcLog(`Failed to download "${d.docName}": ${result.error}`, 'error');
    }
  }
  return { files, failed };
}

$('caseDocsDownloadAllBtn').addEventListener('click', async () => {
  const noticeId  = state.ntcCaseDocsNoticeId;
  const documents = state.ntcCaseDocsList;
  if (!noticeId || !documents.length) return;

  const btn = $('caseDocsDownloadAllBtn');
  btn.disabled = true;
  const origText = btn.textContent;

  const { files, failed } = await downloadAllCaseDocs(noticeId, documents, (i, total) => {
    btn.textContent = `Downloading ${i + 1}/${total}…`;
  });

  btn.disabled = false;
  btn.textContent = origText;

  if (!files.length) {
    addNtcLog('No documents were downloaded — nothing to zip.', 'error');
    return;
  }

  const defaultName = `case_${noticeId}_documents.zip`;
  const saveRes = await window.gstApp.saveZip({ files, defaultName });
  if (saveRes.canceled) { addNtcLog('Save cancelled.', 'info'); return; }
  if (saveRes.ok) {
    const note = failed ? ` (${failed} document${failed === 1 ? '' : 's'} failed)` : '';
    addNtcLog(`✓ Saved ZIP: ${saveRes.filePath} — ${files.length} document${files.length === 1 ? '' : 's'}${note}`, 'ok');
    window.gstApp.openFile(saveRes.filePath);
  } else {
    addNtcLog(`ZIP save failed: ${saveRes.error}`, 'error');
  }
});

$('caseDocsEmailAllBtn').addEventListener('click', async () => {
  const noticeId  = state.ntcCaseDocsNoticeId;
  const documents = state.ntcCaseDocsList;
  if (!noticeId || !documents.length) return;

  const btn = $('caseDocsEmailAllBtn');
  btn.disabled = true;
  try {
    const notice = state.ntcNotices.find(n => n.id === noticeId);
    await emailWithConfirm(async () => {
      const { files, failed } = await downloadAllCaseDocs(noticeId, documents, (i, total) => {
        btn.textContent = `Downloading ${i + 1}/${total}…`;
      });
      if (!files.length) return { ok: false, error: 'No documents could be downloaded.' };
      const zipRes = await window.gstApp.zipToBase64({ files });
      if (!zipRes.ok) return { ok: false, error: zipRes.error };
      if (failed) addNtcLog(`${failed} document${failed === 1 ? '' : 's'} failed to download and won't be in the ZIP.`, 'warn');
      return { ok: true, base64: zipRes.base64, filename: `case_${noticeId}_documents.zip` };
    }, { gstin: val('ntcAccountGstin'), noticeId, description: notice?.description });
  } finally {
    btn.disabled = false;
    btn.textContent = '✉ Email All';
  }
});

// ── AI Summary modal ───────────────────────────────────────────────────────────
const AI_PROVIDER_LABELS = { groq: 'Groq', openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini' };
const AI_MODEL_CATALOG = {
  anthropic: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5'],
  gemini:    ['gemini-3.5-flash'],
  openai:    ['gpt-5.5'],
  groq:      ['llama-3.3-70b-versatile'],
};

async function openAiSummaryModal(notice, documents) {
  state.aiSummaryNotice = notice;
  state.aiSummaryDocs   = documents;

  $('aiSummaryNoticeId').textContent = notice.id;
  $('aiSummaryDocCount').textContent = documents.length;
  const docList = $('aiSummaryDocList');
  docList.innerHTML = documents.length
    ? documents.map(d => `<li>${escHtml(d.docName)}</li>`).join('')
    : '<li class="text-muted">No documents found in this case folder.</li>';

  $('aiSummaryError').classList.add('hidden');
  $('aiSummaryResultWrap').classList.add('hidden');
  $('aiSummarySetup').classList.remove('hidden');
  $('aiSummaryConfirmBtn').disabled = documents.length === 0;

  await loadAiKeys();
  const provider = $('aiSummaryProvider');
  provider.innerHTML = '<option value="">— select —</option>' + AI_PROVIDERS
    .filter(p => (aiKeys[p] || []).length > 0)
    .map(p => `<option value="${p}">${AI_PROVIDER_LABELS[p]}</option>`)
    .join('');
  $('aiSummaryKey').innerHTML = '<option value="">— select provider first —</option>';
  $('aiSummaryModel').innerHTML = '<option value="">— select provider first —</option>';
  $('aiSummaryCustomModelField').classList.add('hidden');

  if (!provider.options.length || (provider.options.length === 1 && !provider.options[0].value)) {
    $('aiSummaryError').textContent = 'No AI provider keys saved yet — add one via "Manage AI" first.';
    $('aiSummaryError').classList.remove('hidden');
  }

  show('aiSummaryModal');
}

function populateAiKeyAndModelDropdowns() {
  const provider = val('aiSummaryProvider');
  const keySel = $('aiSummaryKey');
  const modelSel = $('aiSummaryModel');

  const keys = provider ? (aiKeys[provider] || []) : [];
  keySel.innerHTML = keys.length
    ? keys.map(k => `<option value="${escHtml(k.id)}">${escHtml(k.label)}</option>`).join('')
    : '<option value="">— no keys for this provider —</option>';

  const models = provider ? (AI_MODEL_CATALOG[provider] || []) : [];
  modelSel.innerHTML = (models.length ? models.map(m => `<option value="${m}">${m}</option>`).join('') : '')
    + '<option value="__custom__">Custom model ID…</option>';
  if (!provider) modelSel.innerHTML = '<option value="">— select provider first —</option>';

  $('aiSummaryCustomModelField').classList.add('hidden');
}
$('aiSummaryProvider').addEventListener('change', populateAiKeyAndModelDropdowns);
$('aiSummaryModel').addEventListener('change', () => {
  $('aiSummaryCustomModelField').classList.toggle('hidden', val('aiSummaryModel') !== '__custom__');
});

$('aiSummaryCloseBtn').addEventListener('click', () => hide('aiSummaryModal'));
$('aiSummaryModal').addEventListener('click', (e) => {
  if (e.target.id === 'aiSummaryModal') hide('aiSummaryModal');
});

$('aiSummaryConfirmBtn').addEventListener('click', async () => {
  const provider = val('aiSummaryProvider');
  const apiKeyId = val('aiSummaryKey');
  const modelSel = val('aiSummaryModel');
  const model = modelSel === '__custom__' ? val('aiSummaryCustomModel') : modelSel;

  const errEl = $('aiSummaryError');
  errEl.classList.add('hidden');
  if (!provider) { errEl.textContent = 'Select an AI provider.'; errEl.classList.remove('hidden'); return; }
  if (!apiKeyId) { errEl.textContent = 'Select an API key.'; errEl.classList.remove('hidden'); return; }
  if (!model)    { errEl.textContent = 'Select or enter a model.'; errEl.classList.remove('hidden'); return; }

  const notice = state.aiSummaryNotice;
  const documents = state.aiSummaryDocs || [];
  const btn = $('aiSummaryConfirmBtn');
  btn.disabled = true;
  const origText = btn.textContent;
  try {
    btn.textContent = 'Downloading documents…';
    const { files, failed } = await downloadAllCaseDocs(notice.id, documents, (i, total) => {
      btn.textContent = `Downloading ${i + 1}/${total}…`;
    });
    if (!files.length) throw new Error('No documents could be downloaded to summarize.');
    if (failed) addNtcLog(`${failed} document${failed === 1 ? '' : 's'} failed to download and won't be included in the summary.`, 'warn');

    btn.textContent = 'Generating summary…';
    const res = await window.gstApp.aiSummarize({
      provider, model, apiKeyId,
      documents: files.map(f => ({ filename: f.name, base64: f.base64 })),
      noticeContext: { gstin: val('ntcAccountGstin'), noticeId: notice.id, description: notice.description },
    });
    if (!res.ok) throw new Error(res.error);

    state.aiSummaryText = res.summary;
    $('aiSummaryResultText').textContent = res.summary;
    $('aiSummarySetup').classList.add('hidden');
    $('aiSummaryResultWrap').classList.remove('hidden');
    addNtcLog(`✨ AI summary generated for ${notice.id}`, 'ok');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
});

$('aiSummaryCopyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.aiSummaryText || '');
    addNtcLog('Summary copied to clipboard.', 'info');
  } catch (e) {
    addNtcLog(`Copy failed: ${e.message}`, 'error');
  }
});

$('aiSummarySavePdfBtn').addEventListener('click', async () => {
  const btn = $('aiSummarySavePdfBtn');
  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = 'Generating PDF…';
  try {
    const notice = state.aiSummaryNotice;
    const genRes = await window.gstApp.generateSummaryPdf({
      text: state.aiSummaryText || '',
      title: `AI Summary — Notice ${notice?.id || ''}`,
    });
    if (!genRes.ok) throw new Error(genRes.error);
    const saveRes = await window.gstApp.saveNoticeFile({
      base64: genRes.base64,
      defaultName: `ai_summary_${notice?.id || 'notice'}.pdf`,
    });
    if (saveRes.canceled) { addNtcLog('Save cancelled.', 'info'); return; }
    if (saveRes.ok) {
      addNtcLog(`✓ Saved: ${saveRes.filePath}`, 'ok');
      window.gstApp.openFile(saveRes.filePath);
    } else {
      throw new Error(saveRes.error);
    }
  } catch (err) {
    addNtcLog(`Save as PDF failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
});

// ── Login & Fetch Notices button ──────────────────────────────────────────────
$('ntcLoginFetchBtn').addEventListener('click', async () => {
  if (!state.endpoint) { alert('Local API not ready. Please wait a moment and try again.'); return; }

  $('ntcLoginFetchBtn').disabled = true;
  $('ntcLogoutBtn').disabled     = true;

  const statusEl = $('ntcStatus');

  try {
    if (!state.ntcSessionId) {
      if (!val('ntcUsername') || !$('ntcPassword').value) {
        alert('Enter the client username and password first.');
        return;
      }
      addNtcLog('Checking endpoint…', 'step');
      const health = await window.gstApp.healthCheck({ endpoint: state.endpoint });
      if (!health.ok) throw new Error(`Cannot reach API — ${health.error || `HTTP ${health.httpStatus}`}`);

      await doNtcLogin();
    }

    addNtcLog('Fetching notices…', 'step');
    statusEl.textContent = 'Fetching notices…';
    statusEl.className   = 'dl-status pending';
    show('ntcStatus');

    let res = await window.gstApp.getNotices({
      endpoint: state.endpoint, apiKey: state.apiKey, sessionId: state.ntcSessionId, section: 'both',
    });
    throwIfApiKeyError(res);

    if (!res.ok && isSessionExpiredResponse(res)) {
      addNtcLog('Session expired — re-authenticating…', 'warn');
      state.ntcSessionId = null;
      updateNtcSessionStatus();
      await doNtcLogin();
      res = await window.gstApp.getNotices({
        endpoint: state.endpoint, apiKey: state.apiKey, sessionId: state.ntcSessionId, section: 'both',
      });
      throwIfApiKeyError(res);
    }

    if (!res.ok) throw new Error(res.error || `HTTP ${res.httpStatus}`);

    const notices = res.data?.notices || [];
    renderNoticesTable(notices);
    addNtcLog(`✓ Found ${notices.length} notice${notices.length === 1 ? '' : 's'}.`, 'ok');
    statusEl.textContent = `✓ ${notices.length} notice${notices.length === 1 ? '' : 's'} found.`;
    statusEl.className   = 'dl-status ok';

  } catch (e) {
    if (e.name === 'ApiKeyError') {
      addNtcLog(e.message, 'error');
    } else {
      addNtcLog(`Error: ${e.message}`, 'error');
    }
    addNtcLog('If this keeps happening, contact: siddharthnahata492@gmail.com', 'info');
    if (e.message !== 'Cancelled by user') {
      window.gstApp.logError({ message: e.message, context: 'notices' });
    }
    statusEl.textContent = `✗ ${e.message}`;
    statusEl.className   = 'dl-status error';
    show('ntcStatus');
    hideNtcCaptcha();
    if (state.ntcCaptchaReject) { state.ntcCaptchaReject(e); state.ntcCaptchaReject = null; }
  } finally {
    $('ntcLoginFetchBtn').disabled = false;
    $('ntcLogoutBtn').disabled     = false;
    updateNtcSessionStatus();
  }
});

// ── Logout (Tab 3) ────────────────────────────────────────────────────────────
$('ntcLogoutBtn').addEventListener('click', async () => {
  if (!state.ntcSessionId) { updateNtcSessionStatus(); return; }
  $('ntcLogoutBtn').disabled = true;
  try {
    await window.gstApp.logout({ endpoint: state.endpoint, apiKey: state.apiKey, sessionId: state.ntcSessionId });
    state.ntcSessionId = null;
    addNtcLog('Logged out of client GST session.', 'info');
  } catch (_) {
    state.ntcSessionId = null;
  } finally {
    updateNtcSessionStatus();
    $('ntcLogoutBtn').disabled = false;
  }
});

$('ntcSavedAccounts').addEventListener('change', () => onAccountSelect('ntcSavedAccounts', 'ntcUsername', 'ntcPassword', 'ntcAccountGstin', 'ntcAccountEmail'));
$('ntcSaveAccountBtn').addEventListener('click', () => saveAccount(addNtcLog, 'ntcUsername', 'ntcPassword', 'ntcAccountGstin', 'ntcAccountEmail'));
$('ntcDeleteAccountBtn').addEventListener('click', () => deleteAccount('ntcSavedAccounts', addNtcLog));
$('ntcUsername').addEventListener('input', () => { state.ntcAccountId = null; });
$('ntcPassword').addEventListener('input', () => { state.ntcAccountId = null; });

// ─────────────────────────────────────────────────────────────────────────────
//  SHARED — health-check, file picker, SMTP sync, config, year dropdowns
// ─────────────────────────────────────────────────────────────────────────────


$('browseBtn').addEventListener('click', async () => {
  const filePath = await window.gstApp.pickFile();
  if (!filePath) return;

  $('filePath').value = filePath;
  const fileInfo = $('fileInfo');
  fileInfo.className   = 'file-info';
  fileInfo.textContent = 'Reading file…';
  show('fileInfo');

  const result = await window.gstApp.readInputFile(filePath);
  if (result.error) {
    fileInfo.className   = 'file-info error';
    fileInfo.textContent = `⚠ ${result.error}`;
    state.inputRows = [];
  } else {
    state.inputRows = result.rows;
    const credNote  = (result.hasUsername && result.hasPassword) ? ' · Credentials ✓' : result.hasUsername ? ' · Username ✓' : '';
    const nameNote  = result.hasName  ? ' · Name ✓'  : '';
    const emailNote = result.hasEmail ? ' · Email ✓' : '';
    fileInfo.textContent = `✓ ${result.total} GSTINs loaded${credNote}${nameNote}${emailNote}`;
    const multiAccount = result.hasUsername && result.hasPassword ? ' — per-row credentials detected' : '';
    addLog(`File loaded: ${result.total} GSTINs${multiAccount} — ${filePath}`, 'ok');
  }
});

$('loadFromDbBtn').addEventListener('click', async () => {
  const fileInfo = $('fileInfo');
  fileInfo.className   = 'file-info';
  fileInfo.textContent = 'Loading accounts…';
  show('fileInfo');

  const accounts = await window.gstApp.listAccounts();
  const withGstin = accounts.filter(a => a.gstin && a.gstin.trim());
  const skipped   = accounts.length - withGstin.length;

  if (!withGstin.length) {
    fileInfo.className   = 'file-info error';
    fileInfo.textContent = `⚠ No saved accounts have a GSTIN — save accounts with GSTIN first.`;
    state.inputRows = [];
    return;
  }

  // Filing status is a public API — one login is enough for all GSTINs.
  // Don't set per-row credentials; the form's single login handles everything.
  const rows = withGstin.map(acc => ({
    gstin: acc.gstin.trim().toUpperCase(),
    email: acc.email || '',
    name:  acc.label || acc.username,
  }));

  state.inputRows      = rows;
  $('filePath').value  = '— Saved Accounts Database —';
  fileInfo.textContent = `✓ ${rows.length} GSTINs loaded from database${skipped ? ` (${skipped} skipped — no GSTIN)` : ''}`;
  addLog(`DB loaded: ${rows.length} GSTINs from saved accounts${skipped ? `, ${skipped} skipped (no GSTIN)` : ''}`, 'ok');
});

$('smtpSecure').addEventListener('change', () => { $('smtpPort').value = $('smtpSecure').value; });
$('smtpPort').addEventListener('change', () => {
  const p = val('smtpPort');
  const opt = [...$('smtpSecure').options].find(o => o.value === p);
  if (opt) $('smtpSecure').value = p;
});

$('dlSmtpSecure').addEventListener('change', () => { $('dlSmtpPort').value = $('dlSmtpSecure').value; });
$('dlSmtpPort').addEventListener('change', () => {
  const p = val('dlSmtpPort');
  const opt = [...$('dlSmtpSecure').options].find(o => o.value === p);
  if (opt) $('dlSmtpSecure').value = p;
});

$('ntcSmtpSecure').addEventListener('change', () => { $('ntcSmtpPort').value = $('ntcSmtpSecure').value; });
$('ntcSmtpPort').addEventListener('change', () => {
  const p = val('ntcSmtpPort');
  const opt = [...$('ntcSmtpSecure').options].find(o => o.value === p);
  if (opt) $('ntcSmtpSecure').value = p;
});

$('month').addEventListener('change', updateFYDisplay);
$('year').addEventListener('change', updateFYDisplay);
$('returnType').addEventListener('change', syncMonthToReturnType);
$('dlMonth').addEventListener('change', updateDlFYDisplay);
$('dlYear').addEventListener('change', updateDlFYDisplay);

// ── Tab 2 download-mode toggle (Single Period / Bulk Range) ──────────────────
function syncDownloadMode() {
  const mode = $('dlMode').value;
  $('dlSingleSection').classList.toggle('hidden', mode !== 'single');
  $('dlBulkSection').classList.toggle('hidden', mode !== 'bulk');
}
$('dlMode').addEventListener('change', syncDownloadMode);

// ── Config persistence ────────────────────────────────────────────────────────
const PERSIST_FIELDS = [
  'username',
  'smtpHost','smtpPort','smtpSecure','smtpUser','smtpFrom','emailSubject','emailBody',
  'month','year','returnType',
  'dlUsername','dlMode','dlReturnType','dlMonth','dlYear',
  'dlBulkReturnType','dlBulkStartMonth','dlBulkStartYear','dlBulkEndMonth','dlBulkEndYear',
  'dlSmtpHost','dlSmtpPort','dlSmtpSecure','dlSmtpUser','dlSmtpFrom','dlEmailSubject','dlEmailBody','dlEmailTo',
  'ntcUsername',
  'ntcSmtpHost','ntcSmtpPort','ntcSmtpSecure','ntcSmtpUser','ntcSmtpFrom','ntcEmailSubject','ntcEmailBody','ntcEmailTo',
];

async function loadSavedConfig() {
  const cfg = await window.gstApp.loadConfig();
  for (const key of PERSIST_FIELDS) {
    if (cfg[key] !== undefined && $(key)) $(key).value = cfg[key];
  }
}

function saveCurrentConfig() {
  const cfg = {};
  for (const key of PERSIST_FIELDS) {
    if ($(key)) cfg[key] = $(key).value;
  }
  window.gstApp.saveConfig(cfg);
}

for (const key of PERSIST_FIELDS) {
  const el = $(key);
  if (el) el.addEventListener('change', saveCurrentConfig);
}

// ── Year dropdowns ────────────────────────────────────────────────────────────
function populateYearDropdown() {
  const curYear = new Date().getFullYear();
  for (const selId of ['year', 'dlYear', 'dlBulkStartYear', 'dlBulkEndYear']) {
    const sel = $(selId);
    if (!sel) continue;
    for (let y = curYear; y >= 2017; y--) {
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = y;
      if (y === curYear) opt.selected = true;
      sel.appendChild(opt);
    }
  }
}

// ── Saved accounts ────────────────────────────────────────────────────────────
let savedAccounts = [];

async function loadAccounts() {
  savedAccounts = await window.gstApp.listAccounts();
  for (const selId of ['savedAccounts', 'dlSavedAccounts', 'ntcSavedAccounts']) {
    const sel = $(selId);
    if (!sel) continue;
    const prev = sel.value;
    sel.innerHTML = '<option value="">— Select saved account —</option>';
    for (const acc of savedAccounts) {
      const opt = document.createElement('option');
      opt.value = acc.id;
      opt.textContent = acc.label;
      sel.appendChild(opt);
    }
    if (prev) sel.value = prev;
  }
  renderManageAccountsList();
}

function renderManageAccountsList() {
  const tbody = $('manageAccountsTbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  for (const acc of savedAccounts) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escHtml(acc.label)}</td>
      <td style="font-family:var(--fm);font-size:11px;">${escHtml(acc.username)}</td>
      <td style="font-family:var(--fm);font-size:11px;">${escHtml(acc.gstin || '—')}</td>
      <td style="font-size:11px;">${escHtml(acc.email || '—')}</td>
      <td><button class="btn-icon btn-icon-danger manage-row-delete" data-id="${escHtml(acc.id)}" title="Delete account">✕</button></td>
    `;
    tbody.appendChild(tr);
  }
  $('manageAccountsEmpty').classList.toggle('hidden', savedAccounts.length > 0);
}

async function onAccountSelect(selId, usernameId, passwordId, gstinId, emailId) {
  const id = $(selId).value;
  if (!id) {
    if (selId === 'dlSavedAccounts')  state.dlAccountId  = null;
    if (selId === 'ntcSavedAccounts') state.ntcAccountId = null;
    return;
  }
  const acc = savedAccounts.find(a => a.id === id);
  if (!acc) return;
  $(usernameId).value = acc.username;
  if (gstinId && $(gstinId)) $(gstinId).value = acc.gstin || '';
  if (emailId  && $(emailId))  $(emailId).value  = acc.email  || '';
  const res = await window.gstApp.getAccountPassword({ id });
  if (res.ok) {
    $(passwordId).value = res.password.trim();
    if (selId === 'dlSavedAccounts')  state.dlAccountId  = id;
    if (selId === 'ntcSavedAccounts') state.ntcAccountId = id;
  } else {
    if (selId === 'dlSavedAccounts')  state.dlAccountId  = null;
    if (selId === 'ntcSavedAccounts') state.ntcAccountId = null;
    addDlLog('⚠ Could not decrypt password for this account — enter it manually.', 'warn');
  }
}

async function saveAccount(logFn, usernameId, passwordId, gstinId, emailId) {
  const username = $(usernameId).value.trim();
  const password = $(passwordId).value.trim();
  const gstin    = gstinId && $(gstinId) ? $(gstinId).value.trim().toUpperCase() : '';
  const email    = emailId  && $(emailId)  ? $(emailId).value.trim()  : '';
  if (!username || !password) { alert('Enter username and password before saving.'); return; }
  const res = await window.gstApp.saveAccount({ label: username, username, password, gstin, email });
  if (res.ok) {
    await loadAccounts();
    $('savedAccounts').value    = res.id;
    $('dlSavedAccounts').value  = res.id;
    $('ntcSavedAccounts').value = res.id;
    logFn(`Account "${username}" saved.`, 'ok');
  } else {
    alert(`Failed to save account: ${res.error}`);
  }
}

async function deleteAccountById(id, logFn) {
  const acc = savedAccounts.find(a => a.id === id);
  if (!acc) return;
  if (!confirm(`Delete saved account "${acc.label}"?`)) return;
  const res = await window.gstApp.deleteAccount({ id });
  if (res.ok) {
    if (state.dlAccountId === id)  state.dlAccountId  = null;
    if (state.ntcAccountId === id) state.ntcAccountId = null;
    await loadAccounts();
    logFn(`Account "${acc.label}" deleted.`, 'info');
  }
}

async function deleteAccount(selId, logFn) {
  const id = $(selId).value;
  if (!id) { alert('Select a saved account to delete.'); return; }
  await deleteAccountById(id, logFn);
}

// ── Credential import / export ────────────────────────────────────────────────
async function importCredentials() {
  const filePath = await window.gstApp.pickFile();
  if (!filePath) return;

  const result = await window.gstApp.readCredentialFile(filePath);
  if (result.error) { addLog(`Import failed: ${result.error}`, 'error'); return; }

  let added = 0, updated = 0;
  for (const row of result.rows) {
    const existing = savedAccounts.find(a => a.username === row.username);
    const res = await window.gstApp.saveAccount({ label: row.label || row.username, username: row.username, password: row.password, gstin: row.gstin || '', email: row.email || '' });
    if (res.ok) existing ? updated++ : added++;
  }

  await loadAccounts();
  addLog(`Credentials imported: ${added} added, ${updated} updated.`, 'ok');
}

async function exportCredentials() {
  if (!savedAccounts.length) { alert('No saved accounts to export.'); return; }
  if (!confirm('Export will include decrypted passwords.\n\nKeep the exported file secure. Continue?')) return;

  const all = await window.gstApp.exportAllAccounts();
  if (all.error) { addLog(`Export failed: ${all.error}`, 'error'); return; }

  const failedLabels = all.filter(a => a.decryptFailed).map(a => a.label);
  if (failedLabels.length) {
    addLog(`⚠ Could not decrypt the password for: ${failedLabels.join(', ')} — exported with a blank password.`, 'warn');
  }

  const data = all.map(a => ({ Label: a.label, Username: a.username, Password: a.password, GSTIN: a.gstin, Email: a.email }));
  const res  = await window.gstApp.saveExcel({ data, defaultName: 'gst_accounts.xlsx' });
  if (res.canceled) return;
  if (res.ok) { addLog(`Accounts exported (${all.length}): ${res.filePath}`, 'ok'); window.gstApp.openFile(res.filePath); }
  else        { addLog(`Export failed: ${res.error}`, 'error'); }
}

$('importCredsBtn').addEventListener('click', importCredentials);
$('exportCredsBtn').addEventListener('click', exportCredentials);
$('clearAllAccountsBtn').addEventListener('click', async () => {
  const confirmed = confirm(
    '⚠ DELETE ALL SAVED ACCOUNTS\n\n' +
    'This will permanently delete every saved account including all stored usernames, passwords, GSTINs and emails.\n\n' +
    'This action cannot be undone. The accounts cannot be recovered.\n\n' +
    'Type OK to confirm.'
  );
  if (!confirmed) return;
  const res = await window.gstApp.clearAllAccounts();
  if (res.ok) {
    state.dlAccountId  = null;
    state.ntcAccountId = null;
    await loadAccounts();
    addLog('All saved accounts deleted.', 'warn');
  } else {
    addLog(`Failed to clear accounts: ${res.error}`, 'error');
  }
});

$('savedAccounts').addEventListener('change', () => onAccountSelect('savedAccounts', 'username', 'password', 'accountGstin', 'accountEmail'));
$('saveAccountBtn').addEventListener('click', () => saveAccount(addLog, 'username', 'password', 'accountGstin', 'accountEmail'));
$('deleteAccountBtn').addEventListener('click', () => deleteAccount('savedAccounts', addLog));

$('dlSavedAccounts').addEventListener('change', () => onAccountSelect('dlSavedAccounts', 'dlUsername', 'dlPassword', 'dlAccountGstin', 'dlAccountEmail'));
$('dlSaveAccountBtn').addEventListener('click', () => saveAccount(addDlLog, 'dlUsername', 'dlPassword', 'dlAccountGstin', 'dlAccountEmail'));
$('dlDeleteAccountBtn').addEventListener('click', () => deleteAccount('dlSavedAccounts', addDlLog));

function openManageAccountsModal() {
  renderManageAccountsList();
  show('manageAccountsModal');
}
$('manageAccountsBtn').addEventListener('click', openManageAccountsModal);
$('manageAccountsCloseBtn').addEventListener('click', () => hide('manageAccountsModal'));
$('manageAccountsModal').addEventListener('click', (e) => {
  if (e.target.id === 'manageAccountsModal') hide('manageAccountsModal');
});
$('manageAccountsTbody').addEventListener('click', (e) => {
  const btn = e.target.closest('.manage-row-delete');
  if (!btn) return;
  deleteAccountById(btn.dataset.id, addLog);
});

$('dlUsername').addEventListener('input', () => { state.dlAccountId = null; });
$('dlPassword').addEventListener('input', () => { state.dlAccountId = null; });

// ── Manage AI provider keys ────────────────────────────────────────────────────
const AI_PROVIDERS = ['groq', 'openai', 'anthropic', 'gemini'];
let aiKeys = { groq: [], openai: [], anthropic: [], gemini: [] };

async function loadAiKeys() {
  try { aiKeys = await window.gstApp.listAiKeys(); } catch (_) { /* keep previous */ }
}

function renderAiKeysList() {
  for (const provider of AI_PROVIDERS) {
    const tbody = document.querySelector(`.ai-keys-tbody[data-provider="${provider}"]`);
    const empty = document.querySelector(`.ai-keys-empty[data-provider="${provider}"]`);
    if (!tbody) continue;
    tbody.innerHTML = '';
    const list = aiKeys[provider] || [];
    for (const k of list) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escHtml(k.label)}</td>
        <td><button class="btn-icon btn-icon-danger ai-key-delete" data-provider="${provider}" data-id="${escHtml(k.id)}" title="Delete key">✕</button></td>
      `;
      tbody.appendChild(tr);
    }
    if (empty) empty.classList.toggle('hidden', list.length > 0);
  }
}

async function openManageAiModal() {
  await loadAiKeys();
  renderAiKeysList();
  show('manageAiModal');
}
$('manageAiBtn').addEventListener('click', openManageAiModal);
$('manageAiCloseBtn').addEventListener('click', () => hide('manageAiModal'));
$('manageAiModal').addEventListener('click', (e) => {
  if (e.target.id === 'manageAiModal') hide('manageAiModal');
});

$('manageAiModal').addEventListener('click', async (e) => {
  const getKeyBtn = e.target.closest('.ai-get-key-btn');
  if (getKeyBtn) {
    window.gstApp.openExternal(getKeyBtn.dataset.url);
    return;
  }

  const addBtn = e.target.closest('.ai-add-key-btn');
  if (addBtn) {
    const provider = addBtn.dataset.provider;
    const section = addBtn.closest('.ai-provider-section');
    const labelInput = section.querySelector('.ai-key-label');
    const keyInput = section.querySelector('.ai-key-input');
    const apiKey = keyInput.value.trim();
    if (!apiKey) { alert('Enter an API key first.'); return; }
    addBtn.disabled = true;
    try {
      const res = await window.gstApp.saveAiKey({ provider, label: labelInput.value.trim(), apiKey });
      if (res.ok) {
        labelInput.value = '';
        keyInput.value = '';
        await loadAiKeys();
        renderAiKeysList();
      } else {
        alert(`Could not save key: ${res.error}`);
      }
    } finally {
      addBtn.disabled = false;
    }
    return;
  }

  const delBtn = e.target.closest('.ai-key-delete');
  if (delBtn) {
    await window.gstApp.deleteAiKey({ provider: delBtn.dataset.provider, id: delBtn.dataset.id });
    await loadAiKeys();
    renderAiKeysList();
  }
});

// ── Local API status ──────────────────────────────────────────────────────────
async function initLocalApi() {
  try {
    const port = await window.gstApp.getLocalApiPort();
    if (port) {
      state.endpoint = `http://127.0.0.1:${port}`;
      state.apiKey   = null;
    } else {
      setStatus('Local API failed to start — restart the app', 'error');
    }
  } catch (e) {
    setStatus(`Local API error: ${e.message}`, 'error');
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
  populateYearDropdown();
  await loadSavedConfig();
  await loadAccounts();
  await initLocalApi();
  syncMonthToReturnType();
  syncDownloadMode();
  updateFYDisplay();
  updateDlFYDisplay();
  updateDlSessionStatus();
  addLog('GST Filing Status Checker ready.', 'ok');
  addLog('Select a file, set login credentials, then click Login & Run.', 'info');
  addDlLog('For PDF downloads, enter client credentials and click Login & Download PDF.', 'info');

  const appVersion = await window.gstApp.getAppVersion();
  if (appVersion) {
    $('headerVersionBadge').textContent = `v${appVersion}`;
    $('appVersionLabel').textContent    = `v${appVersion}`;
  }

  $('debugModeToggle').checked = await window.gstApp.getDebugMode();
  $('debugModeToggle').addEventListener('change', async (e) => {
    await window.gstApp.setDebugMode({ enabled: e.target.checked });
    alert(`Debug diagnostics ${e.target.checked ? 'enabled' : 'disabled'} — restart the app for this to take effect.`);
  });

  function compareSemver(a, b) {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] - pb[i]; }
    return 0;
  }

  window.gstApp.onUpdateStatus(data => {
    if (data.version && appVersion && compareSemver(data.version, appVersion) <= 0) return; // stale cache, ignore
    if (data.type === 'available') {
      $('updateBannerText').textContent = `Update v${data.version} is downloading in the background…`;
      show('updateBanner');
      $('updateRestartBtn').style.display = 'none';
    } else if (data.type === 'progress') {
      $('updateBannerText').textContent = `Downloading update… ${data.percent}%`;
    } else if (data.type === 'ready') {
      $('updateBannerText').textContent = `v${data.version} ready to install.`;
      $('updateRestartBtn').style.display = '';
      show('updateBanner');
    } else if (data.type === 'error') {
      $('updateBannerText').textContent = `Update failed — will retry later.`;
      $('updateRestartBtn').style.display = 'none';
      show('updateBanner');
    }
  });

  $('updateRestartBtn').addEventListener('click', () => window.gstApp.installUpdate());
})();
