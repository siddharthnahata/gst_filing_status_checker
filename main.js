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
  };

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
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf8');
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

  autoUpdater.on('update-available', (info) => {
    console.log(`[updater] Update available: v${info.version}`);
    mainWindow?.webContents.send('update-status', { type: 'available', version: info.version });
  });

  autoUpdater.on('download-progress', (p) => {
    const pct = Math.round(p.percent);
    if (pct % 20 === 0) {
      mainWindow?.webContents.send('update-status', { type: 'progress', percent: pct });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[updater] Update downloaded: v${info.version}`);
    mainWindow?.webContents.send('update-status', { type: 'ready', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] Error:', err.message);
  });

  // Check 12 s after startup so it doesn't delay app launch
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 12000);
}

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall(false, true); // isSilent=false, isForceRunAfter=true
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

ipcMain.handle('log-error', (_event, { message, context }) => {
  try {
    const logPath = path.join(app.getPath('userData'), 'error.log');
    const line = `[${new Date().toISOString()}] ${context || 'app'}: ${message}\n`;
    fs.appendFileSync(logPath, line, 'utf8');
  } catch (_) {}
  return { ok: true };
});

ipcMain.handle('report-captcha', (_event, { captchaText, captchaBase64 }) => {
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

ipcMain.handle('save-account', (_event, { label, username, password, gstin, email }) => {
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
    return readAccounts().map(a => {
      let password = '';
      try { password = safeStorage.decryptString(Buffer.from(a.encryptedPassword, 'base64')); } catch (_) {}
      return { label: a.label, username: a.username, password, gstin: a.gstin || '', email: a.email || '' };
    });
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('delete-account', (_event, { id }) => {
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

ipcMain.handle('get-account-password', (_event, { id }) => {
  try {
    const account = readAccounts().find(a => a.id === id);
    if (!account) return { ok: false, error: 'Account not found' };
    const password = safeStorage.decryptString(Buffer.from(account.encryptedPassword, 'base64'));
    return { ok: true, password };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('load-config', () => loadConfig());

ipcMain.handle('save-config', (_event, config) => {
  saveConfig(config);
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

ipcMain.handle('api-health', async (_event, { endpoint }) => {
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

ipcMain.handle('api-login', async (_event, { endpoint, apiKey, username, password }) => {
  try {
    return await apiFetch(`${endpoint}/auth/login`, { username, password }, apiKey);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('api-captcha', async (_event, { endpoint, apiKey, sessionId, captcha }) => {
  try {
    return await apiFetch(`${endpoint}/auth/captcha`, { sessionId, captcha }, apiKey);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('api-filing-status', async (_event, { endpoint, apiKey, sessionId, gstin, financialYear }) => {
  try {
    return await apiFetch(`${endpoint}/public/filing-status`, { sessionId, gstin, financialYear }, apiKey);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('api-logout', async (_event, { endpoint, apiKey, sessionId }) => {
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

ipcMain.handle('save-excel', async (_event, { data, defaultName }) => {
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

ipcMain.handle('send-email', async (_event, { smtpConfig, to, subject, html, text }) => {
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
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('open-file', (_event, filePath) => {
  shell.openPath(filePath);
});

ipcMain.handle('api-download-pdf', async (_event, { endpoint, apiKey, sessionId, returnType, financialYear, returnPeriod }) => {
  try {
    const route = returnType === 'GSTR3B'
      ? '/returns/gstr3b/download-pdf'
      : '/returns/gstr1/download-pdf';
    return await apiFetch(`${endpoint}${route}`, { sessionId, financialYear, returnPeriod }, apiKey);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('save-pdf', async (_event, { base64, defaultName }) => {
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

ipcMain.handle('save-zip', async (_event, { files, defaultName }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Bulk Download ZIP',
    defaultPath: defaultName || 'returns.zip',
    filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
  });
  if (result.canceled) return { canceled: true };
  try {
    const zip = new JSZip();
    for (const { name, base64 } of files) {
      zip.file(name, Buffer.from(base64, 'base64'));
    }
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    fs.writeFileSync(result.filePath, buf);
    return { ok: true, filePath: result.filePath, count: files.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
