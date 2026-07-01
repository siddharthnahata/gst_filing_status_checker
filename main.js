'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, utilityProcess, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const xlsx = require('xlsx');
const nodemailer = require('nodemailer');
const JSZip = require('jszip');
const pdfParse = require('pdf-parse');

let mainWindow;
let apiProcess = null;
let localApiPort = null;

// ── Bundled API ───────────────────────────────────────────────────────────────

function findFreePort(start = 40123) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(start, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', () => findFreePort(start + 1).then(resolve, reject));
  });
}

async function waitForApiReady(port, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function startLocalApi() {
  localApiPort = await findFreePort();

  const apiEntry = app.isPackaged
    ? path.join(process.resourcesPath, 'api', 'src', 'index.js')
    : path.join(__dirname, 'api', 'src', 'index.js');

  const chromiumExe = app.isPackaged
    ? path.join(process.resourcesPath, 'chromium', 'chrome.exe')
    : path.join(__dirname, 'chromium', 'chrome.exe');

  const env = {
    ...process.env,
    PORT: String(localApiPort),
    PUPPETEER_HEADLESS: '1',
    PUPPETEER_EXECUTABLE_PATH: chromiumExe,
    // No api-keys.txt → API stays open for local-only access
    API_KEYS_FILE: path.join(app.getPath('temp'), '__gst_no_keys_file_does_not_exist__'),
    // Survives app updates, unlike resourcesPath where the API code itself lives
    PDF_CACHE_DIR: path.join(app.getPath('userData'), 'pdf-cache'),
  };
  if (loadConfig().debugMode) env.GST_DEBUG = '1';

  apiProcess = utilityProcess.fork(apiEntry, [], { env, stdio: 'pipe' });

  apiProcess.stdout?.on('data', (d) => console.log('[API]', d.toString().trim()));
  apiProcess.stderr?.on('data', (d) => console.error('[API-ERR]', d.toString().trim()));

  const ready = await waitForApiReady(localApiPort);
  if (!ready) {
    console.error('[main] API did not become ready in time');
    localApiPort = null;
  }
}

// ── Secrets ───────────────────────────────────────────────────────────────────

function loadSecrets() {
  try {
    const p = app.isPackaged
      ? path.join(process.resourcesPath, 'secrets.json')
      : path.join(__dirname, 'secrets.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { return {}; }
}

const secrets = loadSecrets();

// ── Remote config — fetch fresh captcha server URL + key on startup ───────────
// Developer updates a GitHub Gist (or any stable URL) to rotate keys or move
// the server. The app fetches it every launch and overrides bundled values.
// Set secrets.remoteConfigUrl to the raw Gist URL (without commit hash so it
// always returns the latest version). Falls back to secrets.json if offline.
async function fetchRemoteConfig() {
  const url = secrets.remoteConfigUrl;
  if (!url) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`[remote-config] HTTP ${res.status}`); return; }
    const remote = await res.json();
    if (remote.captchaApiKey)  secrets.captchaApiKey  = remote.captchaApiKey;
    if (remote.captchaServer)  secrets.captchaServer  = remote.captchaServer;
    console.log('[remote-config] loaded — server:', secrets.captchaServer);
  } catch (e) {
    console.warn('[remote-config] fetch failed, using bundled config:', e.message);
  }
}

// ── Machine ID (sent instead of username in captcha reports) ─────────────────

function getMachineId() {
  const cfg = loadConfig();
  if (!cfg.machineId) {
    cfg.machineId = crypto.randomUUID();
    saveConfig(cfg);
  }
  return cfg.machineId;
}

// ── Accounts storage ──────────────────────────────────────────────────────────

const getAccountsPath = () => path.join(app.getPath('userData'), 'accounts.json');

function readAccounts() {
  try { return JSON.parse(fs.readFileSync(getAccountsPath(), 'utf8')); } catch (_) { return []; }
}

function writeAccounts(accounts) {
  fs.writeFileSync(getAccountsPath(), JSON.stringify(accounts, null, 2), 'utf8');
}

// ── AI provider keys storage ───────────────────────────────────────────────────
// Decrypted keys never leave main.js — the renderer only ever sees {id, label}.
// The actual provider call (ai-summarize handler) reads the key here directly.

const AI_PROVIDERS = ['groq', 'openai', 'anthropic', 'gemini'];
const getAiKeysPath = () => path.join(app.getPath('userData'), 'ai-keys.json');

function readAiKeys() {
  try { return JSON.parse(fs.readFileSync(getAiKeysPath(), 'utf8')); } catch (_) { return {}; }
}

function writeAiKeys(keys) {
  fs.writeFileSync(getAiKeysPath(), JSON.stringify(keys, null, 2), 'utf8');
}

function getDecryptedAiKey(provider, id) {
  const entry = (readAiKeys()[provider] || []).find(k => k.id === id);
  if (!entry) return null;
  try { return safeStorage.decryptString(Buffer.from(entry.encryptedKey, 'base64')); }
  catch (_) { return null; }
}

// ── AI case-document summarization ─────────────────────────────────────────────

function buildSummaryPrompt({ gstin, noticeId, description, docCount } = {}) {
  const ctx = [
    noticeId ? `Notice ID: ${noticeId}` : null,
    gstin ? `GSTIN: ${gstin}` : null,
    description ? `Notice description: "${description}"` : null,
  ].filter(Boolean).join(' | ');

  return `You are assisting a Chartered Accountant (CA) in India who handles GST compliance for their clients. You have been given ${docCount} document(s) from a GST notice/case folder${ctx ? ` (${ctx})` : ''}.

Read all the attached documents carefully and produce a structured summary the CA can act on immediately. Use exactly this structure, with these section headings:

## Overview
- Type of notice/order and the issuing authority/officer, if identifiable
- Tax period(s) and financial year(s) involved

## Key Dates
- Date of issue
- Response/compliance deadline (state explicitly if none is found in the documents)
- Any hearing date mentioned

## Core Issue
- What is being alleged, questioned, or demanded, in plain language
- The legal provision/section cited, if any

## Financial Details
- Amounts involved: tax, interest, penalty (break out each if stated separately)
- Any Input Tax Credit (ITC) figures mentioned

## Recommended Next Steps
- Concrete, prioritized actions the CA should take, in order
- Documents or reconciliations likely needed to respond

## Flags & Uncertainties
- Anything ambiguous, illegible, contradictory, or missing that the CA should verify against the originals
- If a compliance deadline is within 7 days or has already passed, say so explicitly as the FIRST line of this section

Be precise and factual — do not invent figures, dates, or provisions that are not present in the documents. If a section has no applicable information, write "Not stated in the documents" rather than guessing.`;
}

async function extractPdfText(base64) {
  const data = await pdfParse(Buffer.from(base64, 'base64'));
  return data.text || '';
}

async function summarizeWithAnthropic({ apiKey, model, documents, prompt }) {
  const content = [
    ...documents.map(d => ({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: d.base64 },
    })),
    { type: 'text', text: prompt },
  ];
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model, max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content }],
    }),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`Anthropic API error: ${json.error?.message || resp.status}`);
  const textBlock = (json.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error(`Anthropic returned no text (stop_reason: ${json.stop_reason})`);
  return textBlock.text;
}

async function summarizeWithGemini({ apiKey, model, documents, prompt }) {
  const parts = [
    { text: prompt },
    ...documents.map(d => ({ inline_data: { mime_type: 'application/pdf', data: d.base64 } })),
  ];
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
    }),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`Gemini API error: ${json.error?.message || resp.status}`);
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
  if (!text) throw new Error(`Gemini returned no text (finishReason: ${json.candidates?.[0]?.finishReason})`);
  return text;
}

async function summarizeWithOpenAI({ apiKey, model, documents, prompt }) {
  const content = [
    { type: 'text', text: prompt },
    ...documents.map(d => ({
      type: 'file',
      file: { filename: d.filename, file_data: `data:application/pdf;base64,${d.base64}` },
    })),
  ];
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_tokens: 4096, temperature: 0.3, messages: [{ role: 'user', content }] }),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`OpenAI API error: ${json.error?.message || resp.status}`);
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error(`OpenAI returned no text (finish_reason: ${json.choices?.[0]?.finish_reason})`);
  return text;
}

// Groq has no PDF/document API — extract text from each PDF first and send it
// as plain text alongside the prompt.
async function summarizeWithGroq({ apiKey, model, documents, prompt }) {
  const extracted = [];
  for (const d of documents) {
    let text = '';
    try { text = await extractPdfText(d.base64); }
    catch (e) { text = `[Could not extract text from "${d.filename}": ${e.message}]`; }
    extracted.push(`--- Document: ${d.filename} ---\n${text.trim() || '(no extractable text — possibly a scanned/image-only page)'}`);
  }
  const fullPrompt = `${prompt}\n\n${extracted.join('\n\n')}`;
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_tokens: 4096, temperature: 0.3, messages: [{ role: 'user', content: fullPrompt }] }),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`Groq API error: ${json.error?.message || resp.status}`);
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error(`Groq returned no text (finish_reason: ${json.choices?.[0]?.finish_reason})`);
  return text;
}

// ── Config persistence ────────────────────────────────────────────────────────

const getConfigPath = () => path.join(app.getPath('userData'), 'gst-checker-config.json');

function loadConfig() {
  // User's saved config takes priority
  try {
    const p = getConfigPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {}

  // Fall back to bundled defaults on first launch
  try {
    const defaultPath = path.join(__dirname, 'default-config.json');
    if (fs.existsSync(defaultPath)) return JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
  } catch (_) {}

  return {};
}

function saveConfig(config) {
  try {
    // Merge onto the existing file rather than overwrite — callers that only
    // know about a subset of fields (e.g. the renderer's persisted form
    // fields) must not silently wipe out machineId/captchaConsentShown/
    // debugMode saved by other code paths.
    const merged = { ...loadConfig(), ...config };
    fs.writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2), 'utf8');
  } catch (_) {}
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    title: 'GST Filing Status Checker',
    backgroundColor: '#0D1117',
  });
  mainWindow.loadFile('index.html');
}

async function showFirstLaunchConsent() {
  const cfg = loadConfig();
  if (cfg.captchaConsentShown) return;

  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Privacy Notice — Captcha Data Collection',
    message: 'This app collects captcha data to improve automation',
    detail:
      'What is collected:\n' +
      '  • The captcha image shown during GST portal login\n' +
      '  • The text you typed to solve it\n' +
      '  • Your GST portal username (optional, for reference)\n\n' +
      'What is NOT collected:\n' +
      '  • Your GST portal password\n' +
      '  • Any filing data, GSTIN, or client information\n' +
      '  • Any personal or financial information\n\n' +
      'This data is used only to build a training dataset for an automatic ' +
      'captcha solver, reducing manual effort in future versions.\n\n' +
      'For questions or concerns: siddharthnahata492@gmail.com',
    buttons: ['Proceed'],
    defaultId: 0,
  });

  cfg.captchaConsentShown = true;
  saveConfig(cfg);
}

// ── Auto-updater ──────────────────────────────────────────────────────────────
function setupAutoUpdater() {
  if (!app.isPackaged) return; // updater only works in packaged builds

  autoUpdater.autoDownload         = true;  // download in background silently
  autoUpdater.autoInstallOnAppQuit = true;  // apply on next natural quit

  let lastProgressBucket = -1;

  autoUpdater.on('update-available', (info) => {
    console.log(`[updater] Update available: v${info.version}`);
    lastProgressBucket = -1;
    mainWindow?.webContents.send('update-status', { type: 'available', version: info.version });
  });

  autoUpdater.on('download-progress', (p) => {
    const pct    = Math.round(p.percent);
    const bucket = Math.floor(pct / 20);
    if (bucket !== lastProgressBucket) {
      lastProgressBucket = bucket;
      mainWindow?.webContents.send('update-status', { type: 'progress', percent: pct });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[updater] Update downloaded: v${info.version}`);
    mainWindow?.webContents.send('update-status', { type: 'ready', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] Error:', err.message);
    mainWindow?.webContents.send('update-status', { type: 'error', message: err.message });
  });

  // Check 12 s after startup, then every hour
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 12000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 60 * 1000);
}

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall(false, true); // isSilent=false, isForceRunAfter=true
});

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('focus-window', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  await fetchRemoteConfig();
  await startLocalApi();
  createWindow();
  mainWindow.webContents.once('did-finish-load', () => showFirstLaunchConsent());
  setupAutoUpdater();
});

app.on('before-quit', () => apiProcess?.kill());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── Helper: fetch with error handling ────────────────────────────────────────

async function apiFetch(url, body, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return { ok: false, httpStatus: res.status, error: `Non-JSON response (HTTP ${res.status}): ${text.substring(0, 300)}` };
  }
  if (!res.ok) {
    return { ok: false, httpStatus: res.status, error: `HTTP ${res.status}`, data };
  }
  return { ok: true, httpStatus: res.status, data };
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('get-local-api-port', () => localApiPort);

ipcMain.handle('log-error', (_event, { message, context } = {}) => {
  try {
    const logPath = path.join(app.getPath('userData'), 'error.log');
    const line = `[${new Date().toISOString()}] ${context || 'app'}: ${message}\n`;
    fs.appendFileSync(logPath, line, 'utf8');
  } catch (_) {}

  // Best-effort remote report — same server/key as captcha reports, never
  // blocks the caller. Context is expected to already exclude username/GSTIN
  // (renderer builds it that way); redact any GSTIN-shaped substring from the
  // message too in case the portal's own error text happens to echo one.
  if (secrets.captchaApiKey) {
    const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g;
    const redact = (s) => (typeof s === 'string' ? s.replace(GSTIN_RE, '[GSTIN]') : s);
    const source = getMachineId();
    const errorServer = secrets.captchaServer || 'http://43.205.243.55:3010';
    fetch(`${errorServer}/errors`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': secrets.captchaApiKey,
      },
      body: JSON.stringify({
        message: redact(message), context: redact(context), source,
        appVersion: app.getVersion(),
        platform: process.platform,
      }),
    }).catch(() => {});
  }

  return { ok: true };
});

ipcMain.handle('report-captcha', (_event, { captchaText, captchaBase64 } = {}) => {
  if (!secrets.captchaApiKey) return { ok: false, reason: 'no key' };
  const source = getMachineId();
  // Fire-and-forget — never block the login flow
  const captchaServer = secrets.captchaServer || 'http://43.205.243.55:3010';
  fetch(`${captchaServer}/captchas`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': secrets.captchaApiKey,
    },
    body: JSON.stringify({ captchaText, captchaBase64, source }),
  }).then(r => r.json()).then(j => {
    console.log(`[captcha-report] saved=${j.saved} id=${j.id} total=${j.total}`);
  }).catch(e => {
    console.error(`[captcha-report] failed: ${e.message}`);
  });
  return { ok: true };
});

ipcMain.handle('list-accounts', () => {
  return readAccounts().map(({ id, label, username, gstin, email }) => ({ id, label, username, gstin: gstin || '', email: email || '' }));
});

ipcMain.handle('save-account', (_event, { label, username, password, gstin, email } = {}) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Encryption not available on this system' };
    const accounts = readAccounts();
    const encryptedPassword = safeStorage.encryptString(password).toString('base64');
    const existing = accounts.find(a => a.username === username);
    if (existing) {
      existing.label            = label || username;
      existing.encryptedPassword = encryptedPassword;
      existing.gstin            = gstin  || existing.gstin  || '';
      existing.email            = email  || existing.email  || '';
    } else {
      accounts.push({ id: crypto.randomUUID(), label: label || username, username, encryptedPassword, gstin: gstin || '', email: email || '' });
    }
    writeAccounts(accounts);
    const saved = accounts.find(a => a.username === username);
    return { ok: true, id: saved.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('export-all-accounts', () => {
  try {
    if (!safeStorage.isEncryptionAvailable()) return { error: 'Encryption not available on this system' };
    return readAccounts().map(a => {
      let password = '';
      let decryptFailed = false;
      try { password = safeStorage.decryptString(Buffer.from(a.encryptedPassword, 'base64')); }
      catch (_) { decryptFailed = true; }
      return { label: a.label, username: a.username, password, gstin: a.gstin || '', email: a.email || '', decryptFailed };
    });
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('delete-account', (_event, { id } = {}) => {
  try {
    writeAccounts(readAccounts().filter(a => a.id !== id));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('clear-all-accounts', () => {
  try {
    writeAccounts([]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-account-password', (_event, { id } = {}) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Encryption not available on this system' };
    const account = readAccounts().find(a => a.id === id);
    if (!account) return { ok: false, error: 'Account not found' };
    const password = safeStorage.decryptString(Buffer.from(account.encryptedPassword, 'base64'));
    return { ok: true, password };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('open-external', (_event, url) => {
  try {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return { ok: false, error: 'Only https URLs are allowed' };
    shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('list-ai-keys', () => {
  const keys = readAiKeys();
  const out = {};
  for (const provider of AI_PROVIDERS) {
    out[provider] = (keys[provider] || []).map(({ id, label }) => ({ id, label }));
  }
  return out;
});

ipcMain.handle('save-ai-key', (_event, { provider, label, apiKey } = {}) => {
  try {
    if (!AI_PROVIDERS.includes(provider)) return { ok: false, error: 'Unknown provider' };
    if (!apiKey || !apiKey.trim()) return { ok: false, error: 'API key is required' };
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Encryption not available on this system' };
    const keys = readAiKeys();
    if (!keys[provider]) keys[provider] = [];
    const id = crypto.randomUUID();
    const encryptedKey = safeStorage.encryptString(apiKey.trim()).toString('base64');
    keys[provider].push({ id, label: (label || '').trim() || `Key ${keys[provider].length + 1}`, encryptedKey });
    writeAiKeys(keys);
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('delete-ai-key', (_event, { provider, id } = {}) => {
  try {
    const keys = readAiKeys();
    if (keys[provider]) keys[provider] = keys[provider].filter(k => k.id !== id);
    writeAiKeys(keys);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('generate-summary-pdf', async (_event, { text, title } = {}) => {
  let win;
  try {
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const bodyHtml = esc(text).replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/\n/g, '<br>');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { font-family: Georgia, 'Times New Roman', serif; font-size: 12px; color: #1a1a1a; padding: 36px 44px; line-height: 1.6; }
      h1 { font-size: 18px; border-bottom: 2px solid #333; padding-bottom: 8px; margin-bottom: 16px; }
      h2 { font-size: 14px; margin-top: 22px; margin-bottom: 6px; color: #222; }
    </style></head><body>
      <h1>${esc(title || 'AI Summary')}</h1>
      ${bodyHtml}
    </body></html>`;

    win = new BrowserWindow({ show: false });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const pdfBuffer = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    return { ok: true, base64: pdfBuffer.toString('base64') };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (win) win.destroy();
  }
});

ipcMain.handle('ai-summarize', async (_event, { provider, model, apiKeyId, documents, noticeContext } = {}) => {
  try {
    if (!AI_PROVIDERS.includes(provider)) return { ok: false, error: 'Unknown provider' };
    if (!model || !model.trim()) return { ok: false, error: 'Model is required' };
    if (!Array.isArray(documents) || !documents.length) return { ok: false, error: 'No documents to summarize' };
    const apiKey = getDecryptedAiKey(provider, apiKeyId);
    if (!apiKey) return { ok: false, error: 'Selected API key not found — it may have been deleted' };

    const prompt = buildSummaryPrompt({ ...noticeContext, docCount: documents.length });
    const fn = {
      anthropic: summarizeWithAnthropic,
      gemini: summarizeWithGemini,
      openai: summarizeWithOpenAI,
      groq: summarizeWithGroq,
    }[provider];
    const summary = await fn({ apiKey, model: model.trim(), documents, prompt });
    return { ok: true, summary };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('load-config', () => loadConfig());

ipcMain.handle('save-config', (_event, config) => {
  saveConfig(config);
  return { ok: true };
});

ipcMain.handle('get-debug-mode', () => !!loadConfig().debugMode);

ipcMain.handle('set-debug-mode', (_event, { enabled } = {}) => {
  const cfg = loadConfig();
  cfg.debugMode = !!enabled;
  saveConfig(cfg);
  return { ok: true };
});

ipcMain.handle('pick-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Input File (CSV or Excel)',
    filters: [
      { name: 'Spreadsheets', extensions: ['xlsx', 'xls', 'csv'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('read-input-file', (_event, filePath) => {
  try {
    const workbook = xlsx.readFile(filePath, { codepage: 65001 });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawData = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    if (rawData.length === 0) return { error: 'File is empty or has no data rows.' };

    const headers = Object.keys(rawData[0]);
    const norm    = h => h.trim().toLowerCase();
    const gstinCol    = headers.find(h => norm(h) === 'gstin');
    const emailCol    = headers.find(h => ['email','mail','e-mail'].includes(norm(h)));
    const nameCol     = headers.find(h => ['name','party name','trade name','legal name','firm name','client name','taxpayer name'].includes(norm(h)));
    const usernameCol = headers.find(h => ['username','user name','user','login'].includes(norm(h)));
    const passwordCol = headers.find(h => ['password','pass','passwd','pwd'].includes(norm(h)));

    if (!gstinCol) {
      return { error: `No "GSTIN" column found. Columns detected: ${headers.join(', ')}` };
    }

    const rows = rawData
      .map(row => ({
        gstin:    String(row[gstinCol]    || '').trim().toUpperCase(),
        email:    emailCol    ? String(row[emailCol]    || '').trim() : '',
        name:     nameCol     ? String(row[nameCol]     || '').trim() : '',
        username: usernameCol ? String(row[usernameCol] || '').trim() : '',
        password: passwordCol ? String(row[passwordCol] || '').trim() : '',
      }))
      .filter(r => r.gstin.length > 0);

    if (rows.length === 0) return { error: 'GSTIN column found but no values.' };

    return { rows, total: rows.length, hasEmail: !!emailCol, hasName: !!nameCol, hasUsername: !!usernameCol, hasPassword: !!passwordCol };
  } catch (e) {
    return { error: `Failed to read file: ${e.message}` };
  }
});

ipcMain.handle('read-credential-file', (_event, filePath) => {
  try {
    const workbook = xlsx.readFile(filePath, { codepage: 65001 });
    const sheet    = workbook.Sheets[workbook.SheetNames[0]];
    const rawData  = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    if (rawData.length === 0) return { error: 'File is empty.' };

    const headers     = Object.keys(rawData[0]);
    const norm        = h => h.trim().toLowerCase();
    const usernameCol = headers.find(h => ['username','user name','user','login'].includes(norm(h)));
    const passwordCol = headers.find(h => ['password','pass','passwd','pwd'].includes(norm(h)));
    const labelCol    = headers.find(h => ['label','name','account','account name'].includes(norm(h)));
    const gstinCol    = headers.find(h => norm(h) === 'gstin');
    const emailCol    = headers.find(h => ['email','mail','e-mail'].includes(norm(h)));

    if (!usernameCol || !passwordCol) {
      return { error: `Need "Username" and "Password" columns. Found: ${headers.join(', ')}` };
    }

    const rows = rawData
      .map(row => ({
        username: String(row[usernameCol] || '').trim(),
        password: String(row[passwordCol] || '').trim(),
        label:    labelCol ? String(row[labelCol] || '').trim() : '',
        gstin:    gstinCol ? String(row[gstinCol] || '').trim().toUpperCase() : '',
        email:    emailCol ? String(row[emailCol] || '').trim() : '',
      }))
      .filter(r => r.username && r.password);

    if (rows.length === 0) return { error: 'No valid rows found (Username and Password must not be empty).' };

    return { rows, total: rows.length };
  } catch (e) {
    return { error: `Failed to read file: ${e.message}` };
  }
});

ipcMain.handle('api-health', async (_event, { endpoint } = {}) => {
  try {
    const res = await fetch(`${endpoint}/health`, { method: 'GET' });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    return { ok: res.ok, httpStatus: res.status, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('api-login', async (_event, { endpoint, apiKey, username, password } = {}) => {
  try {
    return await apiFetch(`${endpoint}/auth/login`, { username, password }, apiKey);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('api-captcha', async (_event, { endpoint, apiKey, sessionId, captcha } = {}) => {
  try {
    return await apiFetch(`${endpoint}/auth/captcha`, { sessionId, captcha }, apiKey);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('api-filing-status', async (_event, { endpoint, apiKey, sessionId, gstin, financialYear } = {}) => {
  try {
    return await apiFetch(`${endpoint}/public/filing-status`, { sessionId, gstin, financialYear }, apiKey);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('api-logout', async (_event, { endpoint, apiKey, sessionId } = {}) => {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    await fetch(`${endpoint}/auth/logout`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sessionId }),
    });
    return { ok: true };
  } catch (_) {
    return { ok: false };
  }
});

ipcMain.handle('save-excel', async (_event, { data, defaultName } = {}) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Filing Status Results',
    defaultPath: defaultName || 'gst_filing_results.xlsx',
    filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
  });
  if (result.canceled) return { canceled: true };

  try {
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(data);

    // Auto-width columns
    const cols = Object.keys(data[0] || {});
    ws['!cols'] = cols.map(key => ({
      wch: Math.min(50, Math.max(key.length + 2, ...data.map(r => String(r[key] || '').length + 2))),
    }));

    xlsx.utils.book_append_sheet(wb, ws, 'Filing Status');
    xlsx.writeFile(wb, result.filePath);
    return { ok: true, filePath: result.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('send-email', async (_event, { smtpConfig, to, subject, html, text, attachments } = {}) => {
  try {
    const secure = parseInt(smtpConfig.port) === 465;
    const transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: parseInt(smtpConfig.port),
      secure,
      auth: {
        user: smtpConfig.user,
        pass: smtpConfig.pass,
      },
    });
    await transporter.sendMail({
      from: smtpConfig.from || smtpConfig.user,
      to,
      subject,
      text,
      html,
      attachments: (attachments || []).map(a => ({
        filename: a.filename,
        content: a.base64,
        encoding: 'base64',
      })),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('open-file', (_event, filePath) => {
  shell.openPath(filePath);
});

ipcMain.handle('api-download-pdf', async (_event, { endpoint, apiKey, sessionId, returnType, financialYear, returnPeriod, forceRefresh } = {}) => {
  try {
    const route = returnType === 'GSTR3B'
      ? '/returns/gstr3b/download-pdf'
      : '/returns/gstr1/download-pdf';
    return await apiFetch(`${endpoint}${route}`, { sessionId, financialYear, returnPeriod, forceRefresh }, apiKey);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('api-notices-list', async (_event, { endpoint, apiKey, sessionId, section } = {}) => {
  try {
    return await apiFetch(`${endpoint}/notices`, { sessionId, section }, apiKey);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('api-notices-download', async (_event, { endpoint, apiKey, sessionId, docId, applnId } = {}) => {
  try {
    return await apiFetch(`${endpoint}/notices/download`, { sessionId, docId, applnId }, apiKey);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('api-notices-case-documents', async (_event, { endpoint, apiKey, sessionId, caseId, arn, caseTypeCd } = {}) => {
  try {
    return await apiFetch(`${endpoint}/notices/case/documents`, { sessionId, caseId, arn, caseTypeCd }, apiKey);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('api-notices-case-download', async (_event, { endpoint, apiKey, sessionId, id, docName, folder } = {}) => {
  try {
    return await apiFetch(`${endpoint}/notices/case/download`, { sessionId, id, docName, folder }, apiKey);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('save-pdf', async (_event, { base64, defaultName } = {}) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Filed Return PDF',
    defaultPath: defaultName || 'return.pdf',
    filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
  });
  if (result.canceled) return { canceled: true };
  try {
    fs.writeFileSync(result.filePath, Buffer.from(base64, 'base64'));
    return { ok: true, filePath: result.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

async function buildZipBuffer(files) {
  const zip = new JSZip();
  const usedNames = new Set();
  for (const { name, base64 } of files) {
    let finalName = name;
    if (usedNames.has(finalName)) {
      const dot  = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext  = dot > 0 ? name.slice(dot) : '';
      let n = 2;
      while (usedNames.has(finalName)) { finalName = `${base} (${n})${ext}`; n++; }
    }
    usedNames.add(finalName);
    zip.file(finalName, Buffer.from(base64, 'base64'));
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { buf, count: usedNames.size };
}

ipcMain.handle('save-zip', async (_event, { files, defaultName } = {}) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Bulk Download ZIP',
    defaultPath: defaultName || 'returns.zip',
    filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
  });
  if (result.canceled) return { canceled: true };
  try {
    const { buf, count } = await buildZipBuffer(files);
    fs.writeFileSync(result.filePath, buf);
    return { ok: true, filePath: result.filePath, count, zipBase64: buf.toString('base64') };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Builds a ZIP entirely in memory (no save dialog) — used by the ✉ "Email
// All" flow, which sends the archive as an attachment without prompting the
// user to also choose a local save location.
ipcMain.handle('zip-to-base64', async (_event, { files } = {}) => {
  try {
    const { buf, count } = await buildZipBuffer(files);
    return { ok: true, base64: buf.toString('base64'), count };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('save-notice-file', async (_event, { base64, defaultName } = {}) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Notice Document',
    defaultPath: defaultName || 'notice-document',
  });
  if (result.canceled) return { canceled: true };
  try {
    fs.writeFileSync(result.filePath, Buffer.from(base64, 'base64'));
    return { ok: true, filePath: result.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
