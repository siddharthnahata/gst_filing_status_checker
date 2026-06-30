'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  // shared
  endpoint: null,
  apiKey:   null,

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
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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
  const month = $('month').value;
  const year  = parseInt($('year').value);
  if (!year) return;
  const fyStart = getFinancialYear(month, year);
  $('fyDisplay').textContent = `→ Financial Year: ${fyStart}-${String(parseInt(fyStart) + 1).slice(2)}`;
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

  return tp.includes(tm);
}

function findMatchingEntry(filingStatus, targetMonth, returnType) {
  if (!Array.isArray(filingStatus)) return null;
  // GSTR1 filers with quarterly frequency file as GSTR1FF — match both
  const types = returnType === 'GSTR1' ? ['GSTR1', 'GSTR1FF'] : [returnType];
  return filingStatus.flat(Infinity).find(e =>
    e && types.includes(e.rtntype) && matchesPeriod(e.taxp, targetMonth) && e.status === 'Filed'
  ) || null;
}

// ── Session expiry detection ──────────────────────────────────────────────────
function isSessionExpiredResponse(result) {
  if (result.httpStatus === 401 && isApiKeyError(result)) return false;
  if (result.httpStatus === 401 || result.httpStatus === 403) return true;
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

// ── Tab 1 captcha ─────────────────────────────────────────────────────────────
function showCaptcha(base64) {
  $('captchaImg').src = `data:image/png;base64,${base64}`;
  $('captchaInput').value = '';
  $('captchaInput').disabled = false;
  $('captchaSubmitBtn').disabled = false;
  $('captchaError').classList.add('hidden');
  show('captchaSection');
  setTimeout(() => $('captchaInput').focus(), 100);
}

function hideCaptcha() {
  hide('captchaSection');
  $('captchaInput').value = '';
}

function showCaptchaError(msg) {
  const el = $('captchaError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function showCaptchaAndWait(base64) {
  showCaptcha(base64);
  return new Promise((resolve, reject) => {
    state.captchaResolve = resolve;
    state.captchaReject  = reject;
  });
}

// ── Tab 1 login ───────────────────────────────────────────────────────────────
async function doLogin() {
  const endpoint = state.endpoint;
  const apiKey   = state.apiKey;
  const username = val('username');
  const password = $('password').value;

  addLog(`Logging in as "${username}"…`, 'step');
  const res = await window.gstApp.login({ endpoint, apiKey, username, password });
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

// ── Tab 1 captcha handlers ────────────────────────────────────────────────────
$('captchaSubmitBtn').addEventListener('click', handleCaptchaSubmit);
$('captchaInput').addEventListener('keydown', e => { if (e.key === 'Enter') handleCaptchaSubmit(); });

$('captchaRefreshBtn').addEventListener('click', async () => {
  $('captchaRefreshBtn').disabled = true;
  try {
    const res = await window.gstApp.login({
      endpoint: state.endpoint,
      apiKey:   state.apiKey,
      username: val('username'),
      password: $('password').value,
    });
    if (isApiKeyError(res)) {
      const err = new ApiKeyError('API authentication error — try restarting the app.');
      showCaptchaError(err.message);
      if (state.captchaReject) { state.captchaReject(err); state.captchaReject = null; }
      return;
    }
    if (res.ok && res.data.captchaBase64) {
      state.sessionId = res.data.sessionId;
      showCaptcha(res.data.captchaBase64);
      addLog('Captcha refreshed.', 'info');
    }
  } catch (e) {
    addLog(`Refresh failed: ${e.message}`, 'error');
  } finally {
    $('captchaRefreshBtn').disabled = false;
  }
});

async function handleCaptchaSubmit() {
  const captcha = $('captchaInput').value.trim();
  if (!captcha) { showCaptchaError('Please enter the captcha.'); return; }

  $('captchaInput').disabled   = true;
  $('captchaSubmitBtn').disabled = true;
  $('captchaError').classList.add('hidden');

  const res = await window.gstApp.submitCaptcha({
    endpoint: state.endpoint,
    apiKey:   state.apiKey,
    sessionId: state.sessionId,
    captcha,
  });

  if (isApiKeyError(res)) {
    const err = new ApiKeyError('API authentication error — try restarting the app.');
    showCaptchaError(err.message);
    if (state.captchaReject) { state.captchaReject(err); state.captchaReject = null; }
    return;
  }

  if (!res.ok) {
    showCaptchaError(`Error: ${res.error || `HTTP ${res.httpStatus}`}`);
    $('captchaInput').disabled   = false;
    $('captchaSubmitBtn').disabled = false;
    return;
  }

  const d = res.data;

  if (d.loggedIn) {
    state.sessionId = d.sessionId || state.sessionId;
    const name = d.userInfo?.name || d.userInfo?.gstin || '';
    addLog(`Captcha verified — logged in${name ? ` as ${name}` : ''}.`, 'ok');
    window.gstApp.reportCaptcha({ captchaText: captcha, captchaBase64: $('captchaImg').src.split(',')[1] || $('captchaImg').src });
    hideCaptcha();
    if (state.captchaResolve) { state.captchaResolve(); state.captchaResolve = null; }
    return;
  }

  if (d.needsCaptcha && d.captchaBase64) {
    const err = d.errorMessage || 'Incorrect captcha. Please try again.';
    addLog(err, 'warn');
    showCaptchaError(err);
    showCaptcha(d.captchaBase64);
    return;
  }

  showCaptchaError(`Unexpected response: ${JSON.stringify(d)}`);
  $('captchaInput').disabled   = false;
  $('captchaSubmitBtn').disabled = false;
}

// ── Tab 1 re-authenticate mid-batch ──────────────────────────────────────────
async function reAuthenticate() {
  addLog('⚠ Session expired — re-authenticating…', 'warn');
  setStatus('Re-authenticating…', 'running');
  await doLogin();
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
  const rows        = state.inputRows;
  const total       = rows.length;
  const month       = $('month').value;
  const year        = parseInt($('year').value);
  const returnType  = $('returnType').value;
  const financialYear = getFinancialYear(month, year);

  addLog(`─── Batch start: ${total} GSTINs | ${month} ${year} | FY ${financialYear} | ${returnType} ───`, 'step');

  let filed = 0, notFiled = 0, errored = 0, invalid = 0;
  const results = [];

  show('summaryCounts');
  updateSummaryCounts(0, 0, 0, 0, 0);

  for (let i = 0; i < rows.length; i++) {
    if (!state.isRunning) { addLog('Run stopped by user.', 'warn'); break; }

    const { gstin, email, name = '' } = rows[i];
    setProgress(i, total, `Processing ${i + 1} / ${total}: ${gstin}`);

    // Validate GSTIN format before hitting the API
    if (!isValidGSTIN(gstin)) {
      invalid++;
      const result = { gstin, name, email, status: 'Invalid GSTIN', dof: '', arn: '', note: `Bad format (${gstin.length} chars)` };
      results.push(result);
      addLog(`[${i+1}/${total}] ${gstin} → Invalid GSTIN — skipped`, 'warn');
      appendResultRow(results.length, result);
      updateSummaryCounts(filed, notFiled, errored, 0, invalid);
      continue;
    }

    let result;
    try {
      result = await processSingleGSTIN(gstin, name, email, financialYear, month, returnType);
    } catch (e) {
      if (e.name === 'ApiKeyError') throw e;
      result = { gstin, name, email, status: 'Error', dof: '', arn: '', note: e.message };
    }

    results.push(result);

    if (result.status === 'Filed')          { filed++;    addLog(`[${i+1}/${total}] ${gstin} → Filed (${result.dof})${result.note ? ' — ' + result.note : ''}`, 'ok'); }
    else if (result.status === 'Not Filed') { notFiled++; addLog(`[${i+1}/${total}] ${gstin} → Not Filed`, 'warn'); }
    else                                    { errored++;  addLog(`[${i+1}/${total}] ${gstin} → Error: ${result.note}`, 'error'); }

    updateSummaryCounts(filed, notFiled, errored, 0, invalid);
    appendResultRow(results.length, result);

    if (i < rows.length - 1 && state.isRunning) {
      await sleep(300 + Math.random() * 200);
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
    <td style="font-family:var(--font-mono);font-size:12px;">${escHtml(r.gstin)}</td>
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
  if (!state.endpoint)         { alert('Local API not ready. Please wait a moment and try again.'); return; }
  if (!val('username'))        { alert('Enter the GST Portal username.');                  return; }
  if (!$('password').value)    { alert('Enter the portal password.');                     return; }
  if (!state.inputRows.length) { alert('Select an input file with GSTINs first.');        return; }

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

    await doLogin();
    const { filed, notFiled, errored } = await runBatch();

    addLog('Batch complete. Use "Save Excel" to export results or "Send Emails" to notify defaulters.', 'ok');
    updateSummaryCounts(filed, notFiled, errored, 0);

  } catch (e) {
    addLog(`Fatal error: ${e.message}`, 'error');
    addLog('If this keeps happening, contact: siddharthnahata492@gmail.com', 'info');
    window.gstApp.logError({ message: e.message, context: `filing-status | ${$('username').value} | ${$('month').value} ${$('year').value} | ${$('returnType').value}` });
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
function showDlCaptcha(base64) {
  $('dlCaptchaImg').src = `data:image/png;base64,${base64}`;
  $('dlCaptchaInput').value = '';
  $('dlCaptchaInput').disabled = false;
  $('dlCaptchaSubmitBtn').disabled = false;
  $('dlCaptchaError').classList.add('hidden');
  show('dlCaptchaSection');
  setTimeout(() => $('dlCaptchaInput').focus(), 100);
}

function hideDlCaptcha() {
  hide('dlCaptchaSection');
  $('dlCaptchaInput').value = '';
}

function showDlCaptchaError(msg) {
  const el = $('dlCaptchaError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function showDlCaptchaAndWait(base64) {
  showDlCaptcha(base64);
  return new Promise((resolve, reject) => {
    state.dlCaptchaResolve = resolve;
    state.dlCaptchaReject  = reject;
  });
}

// ── Tab 2 login ───────────────────────────────────────────────────────────────
async function doDownloadLogin() {
  const endpoint = state.endpoint;
  const apiKey   = state.apiKey;
  const username = val('dlUsername');
  const password = $('dlPassword').value;

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

// ── Tab 2 captcha handlers ────────────────────────────────────────────────────
$('dlCaptchaSubmitBtn').addEventListener('click', handleDlCaptchaSubmit);
$('dlCaptchaInput').addEventListener('keydown', e => { if (e.key === 'Enter') handleDlCaptchaSubmit(); });

$('dlCaptchaRefreshBtn').addEventListener('click', async () => {
  $('dlCaptchaRefreshBtn').disabled = true;
  try {
    const res = await window.gstApp.login({
      endpoint: state.endpoint,
      apiKey:   state.apiKey,
      username: val('dlUsername'),
      password: $('dlPassword').value,
    });
    if (isApiKeyError(res)) {
      const err = new ApiKeyError('API authentication error — try restarting the app.');
      showDlCaptchaError(err.message);
      if (state.dlCaptchaReject) { state.dlCaptchaReject(err); state.dlCaptchaReject = null; }
      return;
    }
    if (res.ok && res.data.captchaBase64) {
      state.dlSessionId = res.data.sessionId;
      showDlCaptcha(res.data.captchaBase64);
      addDlLog('Captcha refreshed.', 'info');
    }
  } catch (e) {
    addDlLog(`Refresh failed: ${e.message}`, 'error');
  } finally {
    $('dlCaptchaRefreshBtn').disabled = false;
  }
});

async function handleDlCaptchaSubmit() {
  const captcha = $('dlCaptchaInput').value.trim();
  if (!captcha) { showDlCaptchaError('Please enter the captcha.'); return; }

  $('dlCaptchaInput').disabled    = true;
  $('dlCaptchaSubmitBtn').disabled = true;
  $('dlCaptchaError').classList.add('hidden');

  const res = await window.gstApp.submitCaptcha({
    endpoint:  state.endpoint,
    apiKey:    state.apiKey,
    sessionId: state.dlSessionId,
    captcha,
  });

  if (isApiKeyError(res)) {
    const err = new ApiKeyError('API authentication error — try restarting the app.');
    showDlCaptchaError(err.message);
    if (state.dlCaptchaReject) { state.dlCaptchaReject(err); state.dlCaptchaReject = null; }
    return;
  }

  if (!res.ok) {
    showDlCaptchaError(`Error: ${res.error || `HTTP ${res.httpStatus}`}`);
    $('dlCaptchaInput').disabled    = false;
    $('dlCaptchaSubmitBtn').disabled = false;
    return;
  }

  const d = res.data;

  if (d.loggedIn) {
    state.dlSessionId = d.sessionId || state.dlSessionId;
    const name = d.userInfo?.name || d.userInfo?.gstin || '';
    addDlLog(`Captcha verified — logged in${name ? ` as ${name}` : ''}.`, 'ok');
    window.gstApp.reportCaptcha({ captchaText: captcha, captchaBase64: $('dlCaptchaImg').src.split(',')[1] || $('dlCaptchaImg').src });
    hideDlCaptcha();
    updateDlSessionStatus();
    if (state.dlCaptchaResolve) { state.dlCaptchaResolve(); state.dlCaptchaResolve = null; }
    return;
  }

  if (d.needsCaptcha && d.captchaBase64) {
    const err = d.errorMessage || 'Incorrect captcha. Please try again.';
    addDlLog(err, 'warn');
    showDlCaptchaError(err);
    showDlCaptcha(d.captchaBase64);
    return;
  }

  showDlCaptchaError(`Unexpected response: ${JSON.stringify(d)}`);
  $('dlCaptchaInput').disabled    = false;
  $('dlCaptchaSubmitBtn').disabled = false;
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
        sessionId: state.dlSessionId, returnType, financialYear, returnPeriod,
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

    const saveRes = await window.gstApp.savePdf({
      base64:      d.base64,
      defaultName: d.filename || `${returnType}_${returnPeriod}.pdf`,
    });

    if (saveRes.canceled) {
      statusEl.textContent = 'Save cancelled.';
      statusEl.className   = 'dl-status';
      return;
    }

    if (saveRes.ok) {
      const sizeKb = d.size ? Math.round(d.size / 1024) : Math.round(d.base64.length * 0.75 / 1024);
      addDlLog(`✓ Saved: ${saveRes.filePath} (${sizeKb} KB)`, 'ok');
      statusEl.textContent = `✓ Saved ${d.filename || 'return.pdf'} (${sizeKb} KB)`;
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
    window.gstApp.logError({ message: e.message, context: `download | ${val('dlUsername')} | ${$('dlReturnType').value} | ${$('dlMonth').value} ${$('dlYear').value}` });
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
  const returnType = $('dlBulkReturnType').value;

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
        sessionId: state.dlSessionId, returnType, financialYear, returnPeriod,
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
          sessionId: state.dlSessionId, returnType, financialYear, returnPeriod,
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
        const kb = Math.round(d.base64.length * 0.75 / 1024);
        addDlLog(`  → ✓ ${filename} (${kb} KB)`, 'ok');
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
    } else {
      throw new Error(saveRes.error);
    }

  } catch (e) {
    if (e.name === 'ApiKeyError') addDlLog(e.message, 'error');
    else addDlLog(`Error: ${e.message}`, 'error');
    addDlLog('If this keeps happening, contact: siddharthnahata492@gmail.com', 'info');
    window.gstApp.logError({ message: e.message, context: `bulk-download | ${val('dlUsername')} | ${$('dlBulkReturnType').value}` });
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
    const nameNote  = result.hasName  ? ' · Name ✓'  : '';
    const emailNote = result.hasEmail ? ' · Email ✓' : '';
    fileInfo.textContent = `✓ ${result.total} GSTINs loaded${nameNote}${emailNote}`;
    addLog(`File loaded: ${result.total} GSTINs${result.hasName ? ' (with name)' : ''}${result.hasEmail ? ' (with email)' : ''} — ${filePath}`, 'ok');
  }
});

$('smtpSecure').addEventListener('change', () => { $('smtpPort').value = $('smtpSecure').value; });
$('smtpPort').addEventListener('change', () => {
  const p = val('smtpPort');
  const opt = [...$('smtpSecure').options].find(o => o.value === p);
  if (opt) $('smtpSecure').value = p;
});

$('month').addEventListener('change', updateFYDisplay);
$('year').addEventListener('change', updateFYDisplay);
$('dlMonth').addEventListener('change', updateDlFYDisplay);
$('dlYear').addEventListener('change', updateDlFYDisplay);

// ── Config persistence ────────────────────────────────────────────────────────
const PERSIST_FIELDS = [
  'username',
  'smtpHost','smtpPort','smtpSecure','smtpUser','smtpFrom','emailSubject','emailBody',
  'month','year','returnType',
  'dlUsername','dlReturnType','dlMonth','dlYear',
  'dlBulkReturnType','dlBulkStartMonth','dlBulkStartYear','dlBulkEndMonth','dlBulkEndYear',
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
  for (const selId of ['savedAccounts', 'dlSavedAccounts']) {
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
}

async function onAccountSelect(selId, usernameId, passwordId) {
  const id = $(selId).value;
  if (!id) return;
  const acc = savedAccounts.find(a => a.id === id);
  if (!acc) return;
  $(usernameId).value = acc.username;
  const res = await window.gstApp.getAccountPassword({ id });
  if (res.ok) $(passwordId).value = res.password;
}

async function saveAccount(logFn, usernameId, passwordId) {
  const username = $(usernameId).value.trim();
  const password = $(passwordId).value;
  if (!username || !password) { alert('Enter username and password before saving.'); return; }
  const res = await window.gstApp.saveAccount({ label: username, username, password });
  if (res.ok) {
    await loadAccounts();
    $('savedAccounts').value = res.id;
    $('dlSavedAccounts').value = res.id;
    logFn(`Account "${username}" saved.`, 'ok');
  } else {
    alert(`Failed to save account: ${res.error}`);
  }
}

async function deleteAccount(selId, logFn) {
  const id = $(selId).value;
  if (!id) { alert('Select a saved account to delete.'); return; }
  const acc = savedAccounts.find(a => a.id === id);
  if (!acc) return;
  if (!confirm(`Delete saved account "${acc.label}"?`)) return;
  const res = await window.gstApp.deleteAccount({ id });
  if (res.ok) {
    await loadAccounts();
    logFn(`Account "${acc.label}" deleted.`, 'info');
  }
}

$('savedAccounts').addEventListener('change', () => onAccountSelect('savedAccounts', 'username', 'password'));
$('saveAccountBtn').addEventListener('click', () => saveAccount(addLog, 'username', 'password'));
$('deleteAccountBtn').addEventListener('click', () => deleteAccount('savedAccounts', addLog));

$('dlSavedAccounts').addEventListener('change', () => onAccountSelect('dlSavedAccounts', 'dlUsername', 'dlPassword'));
$('dlSaveAccountBtn').addEventListener('click', () => saveAccount(addDlLog, 'dlUsername', 'dlPassword'));
$('dlDeleteAccountBtn').addEventListener('click', () => deleteAccount('dlSavedAccounts', addDlLog));

// ── Local API status bar ──────────────────────────────────────────────────────
async function initLocalApi() {
  const dot   = $('localApiDot');
  const label = $('localApiLabel');
  try {
    const port = await window.gstApp.getLocalApiPort();
    if (port) {
      state.endpoint = `http://127.0.0.1:${port}`;
      state.apiKey   = null;
      dot.className  = 'local-api-dot ready';
      label.textContent = `Local API ready — port ${port}`;
    } else {
      dot.className  = 'local-api-dot error';
      label.textContent = 'Local API failed to start — restart the app';
    }
  } catch (e) {
    dot.className  = 'local-api-dot error';
    label.textContent = `Local API error: ${e.message}`;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
  populateYearDropdown();
  await loadSavedConfig();
  await loadAccounts();
  await initLocalApi();
  updateFYDisplay();
  updateDlFYDisplay();
  updateDlSessionStatus();
  addLog('GST Filing Status Checker ready.', 'ok');
  addLog('Select a file, set login credentials, then click Login & Run.', 'info');
  addDlLog('For PDF downloads, enter client credentials and click Login & Download PDF.', 'info');
})();
