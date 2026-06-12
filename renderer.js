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
    throw new ApiKeyError('Invalid or missing API key — check the API Key field in the top bar.');
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
  return filingStatus.flat(Infinity).find(e =>
    e && e.rtntype === returnType && matchesPeriod(e.taxp, targetMonth) && e.status === 'Filed'
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
      const err = new ApiKeyError('Invalid or missing API key — check the API Key field.');
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
    const err = new ApiKeyError('Invalid or missing API key — check the API Key field.');
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
async function processSingleGSTIN(gstin, email, financialYear, targetMonth, returnType, retryCount = 0) {
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
      return processSingleGSTIN(gstin, email, financialYear, targetMonth, returnType, retryCount + 1);
    }
    return { gstin, email, status: 'Error', dof: '', arn: '', note: res.error || `HTTP ${res.httpStatus}` };
  }

  if (retryCount < 1 && isSessionExpiredResponse(res)) {
    await reAuthenticate();
    return processSingleGSTIN(gstin, email, financialYear, targetMonth, returnType, retryCount + 1);
  }

  const d = res.data;
  const entry = findMatchingEntry(d.filingStatus, targetMonth, returnType);

  if (entry) {
    return { gstin, email, status: 'Filed', dof: entry.dof || '', arn: entry.arn || '', note: '' };
  }

  const topStatus    = d.status || '';
  const hasAnyRecords = Array.isArray(d.filingStatus) && d.filingStatus.flat(Infinity).length > 0;
  const note = !hasAnyRecords && topStatus.toLowerCase().includes('no records') ? 'No records on portal' : '';
  return { gstin, email, status: 'Not Filed', dof: '', arn: '', note };
}

async function runBatch() {
  const rows        = state.inputRows;
  const total       = rows.length;
  const month       = $('month').value;
  const year        = parseInt($('year').value);
  const returnType  = $('returnType').value;
  const financialYear = getFinancialYear(month, year);

  addLog(`─── Batch start: ${total} GSTINs | ${month} ${year} | FY ${financialYear} | ${returnType} ───`, 'step');

  let filed = 0, notFiled = 0, errored = 0;
  const results = [];

  show('summaryCounts');
  updateSummaryCounts(0, 0, 0, 0);

  for (let i = 0; i < rows.length; i++) {
    if (!state.isRunning) { addLog('Run stopped by user.', 'warn'); break; }

    const { gstin, email } = rows[i];
    setProgress(i, total, `Processing ${i + 1} / ${total}: ${gstin}`);

    let result;
    try {
      result = await processSingleGSTIN(gstin, email, financialYear, month, returnType);
    } catch (e) {
      if (e.name === 'ApiKeyError') throw e;
      result = { gstin, email, status: 'Error', dof: '', arn: '', note: e.message };
    }

    results.push(result);

    if (result.status === 'Filed')       { filed++;    addLog(`[${i+1}/${total}] ${gstin} → Filed (${result.dof})`, 'ok'); }
    else if (result.status === 'Not Filed') { notFiled++; addLog(`[${i+1}/${total}] ${gstin} → Not Filed`, 'warn'); }
    else                                 { errored++;  addLog(`[${i+1}/${total}] ${gstin} → Error: ${result.note}`, 'error'); }

    updateSummaryCounts(filed, notFiled, errored, 0);
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
  const badgeClass = r.status === 'Filed' ? 'filed' : r.status === 'Not Filed' ? 'notfiled' : 'error';
  const icon = r.status === 'Filed' ? '✓' : r.status === 'Not Filed' ? '✗' : '⚠';
  tr.innerHTML = `
    <td>${n}</td>
    <td style="font-family:var(--font-mono);font-size:12px;">${escHtml(r.gstin)}</td>
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

function updateSummaryCounts(filed, notFiled, errored, emailed) {
  $('summaryCounts').innerHTML = `
    <span class="count-chip filed">✓ ${filed} Filed</span>
    <span class="count-chip notfiled">✗ ${notFiled} Not Filed</span>
    ${errored ? `<span class="count-chip errored">⚠ ${errored} Error</span>` : ''}
    ${emailed ? `<span class="count-chip emailed">✉ ${emailed} Emailed</span>` : ''}
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
  if (!val('endpoint'))        { alert('Enter the API Base URL in the top bar.');          return; }
  if (!val('username'))        { alert('Enter the GST Portal username.');                  return; }
  if (!$('password').value)    { alert('Enter the portal password.');                     return; }
  if (!state.inputRows.length) { alert('Select an input file with GSTINs first.');        return; }

  state.isRunning = true;
  state.results   = [];
  state.endpoint  = val('endpoint').replace(/\/+$/, '');
  state.apiKey    = $('apiKey').value.trim() || null;

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
      const err = new ApiKeyError('Invalid or missing API key — check the API Key field.');
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
    const err = new ApiKeyError('Invalid or missing API key — check the API Key field.');
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
  if (!val('endpoint')) { alert('Enter the API Base URL in the top bar.'); return; }

  state.endpoint = val('endpoint').replace(/\/+$/, '');
  state.apiKey   = $('apiKey').value.trim() || null;

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

$('healthBtn').addEventListener('click', async () => {
  const endpoint = val('endpoint').replace(/\/+$/, '');
  if (!endpoint) { alert('Enter an API Base URL first.'); return; }

  $('healthBtn').disabled = true;
  const el = $('healthStatus');
  el.style.cssText = 'margin-top:4px;font-size:11.5px;padding:3px 8px;border-radius:4px;background:#fef3c7;color:#92400e;';
  el.textContent = 'Checking…';
  el.classList.remove('hidden');

  const res = await window.gstApp.healthCheck({ endpoint });
  if (res.ok) {
    el.style.cssText = 'margin-top:4px;font-size:11.5px;padding:3px 8px;border-radius:4px;background:#dcfce7;color:#166534;';
    el.textContent = '✓ Reachable';
  } else {
    el.style.cssText = 'margin-top:4px;font-size:11.5px;padding:3px 8px;border-radius:4px;background:#fee2e2;color:#991b1b;';
    el.textContent = `✗ ${res.error || `HTTP ${res.httpStatus}`}`;
  }
  $('healthBtn').disabled = false;
});

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
    const emailNote = result.hasEmail ? ' · Email column found ✓' : ' · No email column';
    fileInfo.textContent = `✓ ${result.total} GSTINs loaded${emailNote}`;
    addLog(`File loaded: ${result.total} GSTINs${result.hasEmail ? ' (with email)' : ''} — ${filePath}`, 'ok');
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
  'endpoint','apiKey','username',
  'smtpHost','smtpPort','smtpSecure','smtpUser','smtpFrom','emailSubject','emailBody',
  'month','year','returnType',
  'dlUsername','dlReturnType','dlMonth','dlYear',
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
  for (const selId of ['year', 'dlYear']) {
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

// ── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
  populateYearDropdown();
  await loadSavedConfig();
  updateFYDisplay();
  updateDlFYDisplay();
  updateDlSessionStatus();
  addLog('GST Filing Status Checker ready.', 'ok');
  addLog('Select a file, set login credentials, then click Login & Run.', 'info');
  addDlLog('For PDF downloads, enter client credentials and click Login & Download PDF.', 'info');
})();
