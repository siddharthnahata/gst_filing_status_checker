'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  sessionId: null,
  endpoint: null,
  apiKey: null,
  inputRows: [],         // [{gstin, email}]
  results: [],           // [{gstin, status, dof, arn, email, note}]
  isRunning: false,
  captchaResolve: null,
  captchaReject: null,
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
    throw new ApiKeyError('Invalid or missing API key — check the API Key field.');
  }
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }
function val(id)  { return $(id).value.trim(); }

// ── Logging ───────────────────────────────────────────────────────────────────
function addLog(msg, level = 'info') {
  const log = $('log');
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  line.innerHTML = `<span class="ts">${ts}</span><span class="msg">${escHtml(msg)}</span>`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Status dot ────────────────────────────────────────────────────────────────
function setStatus(text, mode = '') {
  $('statusText').textContent = text;
  const dot = $('statusDot');
  dot.className = 'status-dot' + (mode ? ` ${mode}` : '');
}

// ── Progress bar ──────────────────────────────────────────────────────────────
function setProgress(done, total, label) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const bar = $('progressBar');
  bar.style.width = `${pct}%`;
  bar.className = 'progress-bar' + (done === total && total > 0 ? ' complete' : '');
  $('progressLabel').textContent = label || `${done} / ${total}`;
  $('progressPct').textContent = total > 0 ? `${pct}%` : '';
}

// ── Financial year helper ─────────────────────────────────────────────────────
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function getFinancialYear(month, year) {
  const idx = MONTHS.indexOf(month) + 1; // 1-based
  // Apr(4)–Dec(12) → FY starts in selected year
  // Jan(1)–Mar(3)  → FY started in prior year
  return idx >= 4 ? String(year) : String(year - 1);
}

function updateFYDisplay() {
  const month = val('month') || $('month').value;
  const year = parseInt($('year').value);
  if (!year) return;
  const fyStart = getFinancialYear(month || $('month').options[$('month').selectedIndex].value, year);
  const fyEnd = String(parseInt(fyStart) + 1).slice(2);
  $('fyDisplay').textContent = `→ Financial Year: ${fyStart}-${fyEnd}`;
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

  // Direct match (e.g., taxp="May", target="May")
  if (tp === tm) return true;

  // Quarter shorthand Q1–Q4
  if (QUARTER_MONTHS[tp] && QUARTER_MONTHS[tp].includes(tm)) return true;

  // Range like "April-June", "Apr-Jun", "April - June"
  const dashIdx = tp.indexOf('-');
  if (dashIdx > 0) {
    const startStr = tp.substring(0, dashIdx).trim();
    const endStr   = tp.substring(dashIdx + 1).trim();

    const startIdx = MONTH_NAMES.indexOf(startStr) !== -1
      ? MONTH_NAMES.indexOf(startStr)
      : MONTH_ABBR.indexOf(startStr);
    const endIdx = MONTH_NAMES.indexOf(endStr) !== -1
      ? MONTH_NAMES.indexOf(endStr)
      : MONTH_ABBR.indexOf(endStr);
    const targetIdx = MONTH_NAMES.indexOf(tm);

    if (startIdx !== -1 && endIdx !== -1 && targetIdx !== -1) {
      // Handle same-year range (no wrap-around for Indian quarters)
      return targetIdx >= startIdx && targetIdx <= endIdx;
    }
  }

  // Substring fallback (e.g., taxp contains the month name)
  if (tp.includes(tm)) return true;

  return false;
}

function findMatchingEntry(filingStatus, targetMonth, returnType) {
  if (!Array.isArray(filingStatus)) return null;
  const flat = filingStatus.flat(Infinity);
  return flat.find(e =>
    e && e.rtntype === returnType &&
    matchesPeriod(e.taxp, targetMonth) &&
    e.status === 'Filed'
  ) || null;
}

// ── Session expiry detection ──────────────────────────────────────────────────
function isSessionExpiredResponse(result) {
  // Don't confuse an API key 401 with a session expiry 401
  if (result.httpStatus === 401 && isApiKeyError(result)) return false;
  if (result.httpStatus === 401 || result.httpStatus === 403) return true;
  if (!result.ok && !result.data) return false;
  const str = JSON.stringify(result.data || result.error || '').toLowerCase();
  return (
    str.includes('invalid session') ||
    str.includes('session expired') ||
    str.includes('session invalid') ||
    str.includes('please login again') ||
    str.includes('not logged in')
  );
}

// ── Sleep ─────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Captcha section ───────────────────────────────────────────────────────────
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

// Returns a Promise that resolves with the new sessionId once login completes
async function showCaptchaAndWait(base64) {
  showCaptcha(base64);
  return new Promise((resolve, reject) => {
    state.captchaResolve = resolve;
    state.captchaReject  = reject;
  });
}

async function doLogin() {
  const endpoint = state.endpoint;
  const apiKey   = state.apiKey;
  const username = val('username');
  const password = $('password').value;

  addLog(`Logging in as "${username}"…`, 'step');
  const res = await window.gstApp.login({ endpoint, apiKey, username, password });

  throwIfApiKeyError(res);

  if (!res.ok) {
    throw new Error(`Login request failed: ${res.error || `HTTP ${res.httpStatus}`}`);
  }

  const d = res.data;
  state.sessionId = d.sessionId;

  if (d.loggedIn) {
    const name = d.userInfo?.name || d.userInfo?.gstin || '';
    addLog(`Logged in successfully${name ? ` — ${name}` : ''}.`, 'ok');
    return;
  }

  if (d.needsCaptcha && d.captchaBase64) {
    addLog('Captcha required — please enter it in the panel on the right.', 'warn');
    await showCaptchaAndWait(d.captchaBase64);
    return;
  }

  throw new Error(`Unexpected login response: ${JSON.stringify(d)}`);
}

// ── Captcha submit handler ────────────────────────────────────────────────────
$('captchaSubmitBtn').addEventListener('click', handleCaptchaSubmit);
$('captchaInput').addEventListener('keydown', e => { if (e.key === 'Enter') handleCaptchaSubmit(); });

$('captchaRefreshBtn').addEventListener('click', async () => {
  $('captchaRefreshBtn').disabled = true;
  try {
    const res = await window.gstApp.login({
      endpoint: state.endpoint,
      apiKey: state.apiKey,
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

  $('captchaInput').disabled = true;
  $('captchaSubmitBtn').disabled = true;
  $('captchaError').classList.add('hidden');

  const res = await window.gstApp.submitCaptcha({
    endpoint: state.endpoint,
    apiKey: state.apiKey,
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
    $('captchaInput').disabled = false;
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
    showCaptcha(d.captchaBase64); // updates image, re-enables input
    return;
  }

  showCaptchaError(`Unexpected response: ${JSON.stringify(d)}`);
  $('captchaInput').disabled = false;
  $('captchaSubmitBtn').disabled = false;
}

// Re-login mid-batch (session expired)
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
    apiKey: state.apiKey,
    sessionId: state.sessionId,
    gstin,
    financialYear,
  });

  // API key errors are fatal — re-throw to abort the whole batch
  throwIfApiKeyError(res);

  if (!res.ok) {
    // Detect session expiry and retry once
    if (retryCount < 1 && isSessionExpiredResponse(res)) {
      await reAuthenticate();
      return processSingleGSTIN(gstin, email, financialYear, targetMonth, returnType, retryCount + 1);
    }
    const errMsg = res.error || `HTTP ${res.httpStatus}`;
    return { gstin, email, status: 'Error', dof: '', arn: '', note: errMsg };
  }

  const d = res.data;

  // Check session expiry even on successful HTTP responses
  if (retryCount < 1 && isSessionExpiredResponse(res)) {
    await reAuthenticate();
    return processSingleGSTIN(gstin, email, financialYear, targetMonth, returnType, retryCount + 1);
  }

  const entry = findMatchingEntry(d.filingStatus, targetMonth, returnType);

  if (entry) {
    return { gstin, email, status: 'Filed', dof: entry.dof || '', arn: entry.arn || '', note: '' };
  }

  // Not filed — note if truly no records vs just no matching entry
  const topStatus = d.status || '';
  const hasAnyRecords = Array.isArray(d.filingStatus) && d.filingStatus.flat(Infinity).length > 0;
  const note = !hasAnyRecords && topStatus.toLowerCase().includes('no records') ? 'No records on portal' : '';
  return { gstin, email, status: 'Not Filed', dof: '', arn: '', note };
}

async function runBatch() {
  const rows = state.inputRows;
  const total = rows.length;
  const month = $('month').value;
  const year  = parseInt($('year').value);
  const returnType   = $('returnType').value;
  const financialYear = getFinancialYear(month, year);
  const period       = `${month} ${year}`;

  addLog(`─── Batch start: ${total} GSTINs | ${month} ${year} | FY ${financialYear} | ${returnType} ───`, 'step');

  const results = [];
  let filed = 0, notFiled = 0, errored = 0;

  show('summaryCounts');
  updateSummaryCounts(0, 0, 0, 0);

  for (let i = 0; i < rows.length; i++) {
    if (!state.isRunning) {
      addLog('Run stopped by user.', 'warn');
      break;
    }

    const { gstin, email } = rows[i];
    setProgress(i, total, `Processing ${i + 1} / ${total}: ${gstin}`);

    let result;
    try {
      result = await processSingleGSTIN(gstin, email, financialYear, month, returnType);
    } catch (e) {
      if (e.name === 'ApiKeyError') throw e; // abort entire batch
      result = { gstin, email, status: 'Error', dof: '', arn: '', note: e.message };
    }

    results.push(result);

    if (result.status === 'Filed')       { filed++;    addLog(`[${i+1}/${total}] ${gstin} → Filed (${result.dof})`, 'ok'); }
    else if (result.status === 'Not Filed') { notFiled++; addLog(`[${i+1}/${total}] ${gstin} → Not Filed`, 'warn'); }
    else                                 { errored++;  addLog(`[${i+1}/${total}] ${gstin} → Error: ${result.note}`, 'error'); }

    updateSummaryCounts(filed, notFiled, errored, 0);
    appendResultRow(results.length, result);

    if (i < rows.length - 1 && state.isRunning) {
      await sleep(300 + Math.random() * 200); // 300–500 ms gentle delay
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
  const tbody = $('resultsTbody');
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
  tbody.appendChild(tr);
}

function clearResultsTable() {
  $('resultsTbody').innerHTML = '';
  hide('resultsSection');
}

function updateSummaryCounts(filed, notFiled, errored, emailed) {
  $('summaryCounts').innerHTML = `
    <span class="count-chip filed">✓ ${filed} Filed</span>
    <span class="count-chip notfiled">✗ ${notFiled} Not Filed</span>
    ${errored  ? `<span class="count-chip errored">⚠ ${errored} Error</span>` : ''}
    ${emailed  ? `<span class="count-chip emailed">✉ ${emailed} Emailed</span>` : ''}
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
  return text
    .replace(/&/g, '&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\n/g, '<br>');
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
    host:   smtpHost,
    port:   val('smtpPort') || '465',
    user:   smtpUser,
    pass:   smtpPass,
    from:   val('smtpFrom') || smtpUser,
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

    const subject = substituteTemplate(val('emailSubject'), row.gstin, period, returnType);
    const bodyTxt = substituteTemplate($('emailBody').value, row.gstin, period, returnType);
    const bodyHtml = textToHtml(bodyTxt);

    const res = await window.gstApp.sendEmail({
      smtpConfig,
      to: row.email,
      subject,
      text: bodyTxt,
      html: bodyHtml,
    });

    if (res.ok) {
      addLog(`✉ Email sent → ${row.email} (${row.gstin})`, 'ok');
      sent++;
    } else {
      addLog(`✉ Failed → ${row.email} (${row.gstin}): ${res.error}`, 'error');
    }

    await sleep(500);
  }

  addLog(`Email done: ${sent}/${defaulters.length} sent.`, sent === defaulters.length ? 'ok' : 'warn');
  return sent;
}

// ── Main run ──────────────────────────────────────────────────────────────────
$('runBtn').addEventListener('click', async () => {
  // Validate
  if (!val('endpoint'))  { alert('Please enter the API base URL.');  return; }
  if (!val('username'))  { alert('Please enter the username.');        return; }
  if (!$('password').value) { alert('Please enter the password.');   return; }
  if (state.inputRows.length === 0) { alert('Please select an input file with GSTINs first.'); return; }

  // Reset
  state.isRunning = true;
  state.results = [];
  state.endpoint = val('endpoint').replace(/\/+$/, '');
  state.apiKey   = $('apiKey').value.trim() || null;

  clearResultsTable();
  hide('summaryCounts');
  $('runBtn').disabled = true;
  $('stopBtn').disabled = false;
  setStatus('Running…', 'running');
  setProgress(0, 0, 'Starting…');
  addLog('═══════════ Run started ═══════════', 'step');

  try {
    // Health check — validates the base URL before touching auth
    addLog(`Checking endpoint: ${state.endpoint}…`, 'step');
    const health = await window.gstApp.healthCheck({ endpoint: state.endpoint });
    if (!health.ok) {
      throw new Error(`Cannot reach API at ${state.endpoint} — ${health.error || `HTTP ${health.httpStatus}`}`);
    }
    addLog('Endpoint reachable.', 'ok');

    await doLogin();
    const { filed, notFiled, errored } = await runBatch();

    // Save Excel prompt
    const excelData = state.results.map(r => ({
      'GSTIN':          r.gstin,
      'Status':         r.status,
      'Date of Filing': r.dof,
      'ARN':            r.arn,
      'Email':          r.email,
      'Note':           r.note,
    }));

    addLog('Batch complete. Use "Save Excel" to export and "Send Emails" to notify defaulters.', 'ok');

    // Final summary chips
    updateSummaryCounts(filed, notFiled, errored, 0);

    // Logout silently
    if (state.sessionId) {
      window.gstApp.logout({ endpoint: state.endpoint, apiKey: state.apiKey, sessionId: state.sessionId });
      state.sessionId = null;
    }

  } catch (e) {
    addLog(`Fatal error: ${e.message}`, 'error');
    setStatus('Error', 'error');
    hideCaptcha();
    if (state.captchaReject) { state.captchaReject(e); state.captchaReject = null; }
  } finally {
    state.isRunning = false;
    $('runBtn').disabled = false;
    $('stopBtn').disabled = true;
    if ($('statusDot').classList.contains('running')) setStatus('Done', '');
    saveCurrentConfig();
  }
});

$('stopBtn').addEventListener('click', () => {
  state.isRunning = false;
  addLog('Stop requested…', 'warn');
  $('stopBtn').disabled = true;
  if (state.captchaReject) {
    state.captchaReject(new Error('Stopped by user'));
    state.captchaReject = null;
  }
});

$('saveExcelBtn').addEventListener('click', async () => {
  if (state.results.length === 0) { alert('No results to save yet.'); return; }

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
  if (res.ok) {
    addLog(`Excel saved: ${res.filePath}`, 'ok');
    window.gstApp.openFile(res.filePath);
  } else {
    addLog(`Failed to save Excel: ${res.error}`, 'error');
  }
});

$('sendEmailBtn').addEventListener('click', async () => {
  if (state.results.length === 0) { alert('No results yet.'); return; }
  $('sendEmailBtn').disabled = true;
  state.isRunning = true; // allow stop button to work during emails
  $('stopBtn').disabled = false;
  try {
    const sent = await sendEmails();
    // Update count chips to reflect emailed count
    const filed    = state.results.filter(r => r.status === 'Filed').length;
    const notFiled = state.results.filter(r => r.status === 'Not Filed').length;
    const errored  = state.results.filter(r => r.status === 'Error').length;
    updateSummaryCounts(filed, notFiled, errored, sent);
  } finally {
    state.isRunning = false;
    $('sendEmailBtn').disabled = false;
    $('stopBtn').disabled = true;
  }
});

// ── Endpoint health-check button ──────────────────────────────────────────────
$('healthBtn').addEventListener('click', async () => {
  const endpoint = val('endpoint').replace(/\/+$/, '');
  if (!endpoint) { alert('Enter an API Base URL first.'); return; }

  $('healthBtn').disabled = true;
  const el = $('healthStatus');
  el.style.cssText = 'margin-top:5px;font-size:11.5px;padding:4px 8px;border-radius:4px;background:#fef3c7;color:#92400e;';
  el.textContent = 'Checking…';
  el.classList.remove('hidden');

  const res = await window.gstApp.healthCheck({ endpoint });
  if (res.ok) {
    el.style.cssText = 'margin-top:5px;font-size:11.5px;padding:4px 8px;border-radius:4px;background:#dcfce7;color:#166534;';
    el.textContent = '✓ Reachable';
  } else {
    el.style.cssText = 'margin-top:5px;font-size:11.5px;padding:4px 8px;border-radius:4px;background:#fee2e2;color:#991b1b;';
    el.textContent = `✗ ${res.error || `HTTP ${res.httpStatus}`}`;
  }
  $('healthBtn').disabled = false;
});

// ── File picker ───────────────────────────────────────────────────────────────
$('browseBtn').addEventListener('click', async () => {
  const filePath = await window.gstApp.pickFile();
  if (!filePath) return;

  $('filePath').value = filePath;
  const fileInfo = $('fileInfo');
  fileInfo.className = 'file-info';
  fileInfo.textContent = 'Reading file…';
  show('fileInfo');

  const result = await window.gstApp.readInputFile(filePath);
  if (result.error) {
    fileInfo.className = 'file-info error';
    fileInfo.textContent = `⚠ ${result.error}`;
    state.inputRows = [];
  } else {
    state.inputRows = result.rows;
    const emailNote = result.hasEmail ? ' · Email column found ✓' : ' · No email column (emails will be skipped)';
    fileInfo.textContent = `✓ ${result.total} GSTINs loaded${emailNote}`;
    addLog(`File loaded: ${result.total} GSTINs${result.hasEmail ? ' (with email)' : ''} — ${filePath}`, 'ok');
  }
});

// ── SMTP port sync ─────────────────────────────────────────────────────────────
$('smtpSecure').addEventListener('change', () => {
  $('smtpPort').value = $('smtpSecure').value;
});

$('smtpPort').addEventListener('change', () => {
  // Sync the select to known ports
  const p = val('smtpPort');
  const opt = [...$('smtpSecure').options].find(o => o.value === p);
  if (opt) $('smtpSecure').value = p;
});

// ── FY display ────────────────────────────────────────────────────────────────
$('month').addEventListener('change', updateFYDisplay);
$('year').addEventListener('change', updateFYDisplay);

// ── Config persistence ────────────────────────────────────────────────────────
// apiKey is a secret but we persist it so the user doesn't re-type it on every launch
const PERSIST_FIELDS = ['endpoint','apiKey','username','smtpHost','smtpPort','smtpSecure','smtpUser','smtpFrom','emailSubject','emailBody','month','year','returnType'];

async function loadSavedConfig() {
  const cfg = await window.gstApp.loadConfig();
  for (const key of PERSIST_FIELDS) {
    if (cfg[key] !== undefined && $(key)) {
      $(key).value = cfg[key];
    }
  }
}

function saveCurrentConfig() {
  const cfg = {};
  for (const key of PERSIST_FIELDS) {
    if ($(key)) cfg[key] = $(key).value;
  }
  window.gstApp.saveConfig(cfg);
}

// Auto-save config on change for non-sensitive fields
for (const key of PERSIST_FIELDS) {
  const el = $(key);
  if (el) el.addEventListener('change', saveCurrentConfig);
}

// ── Year dropdown population ───────────────────────────────────────────────────
function populateYearDropdown() {
  const sel = $('year');
  const curYear = new Date().getFullYear();
  for (let y = curYear; y >= 2017; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    if (y === curYear) opt.selected = true;
    sel.appendChild(opt);
  }
}

// ── Init ───────────────────────────────────────────────────────────────────────
(async function init() {
  populateYearDropdown();
  await loadSavedConfig();
  updateFYDisplay();
  addLog('GST Filing Status Checker ready.', 'ok');
  addLog('Select a file, configure settings, then click Login & Run.', 'info');
})();
