'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
const nodemailer = require('nodemailer');
const JSZip = require('jszip');

let mainWindow;

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
    backgroundColor: '#f5f7fa',
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

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
    const gstinCol = headers.find(h => h.trim().toLowerCase() === 'gstin');
    const emailCol = headers.find(h => ['email', 'mail', 'e-mail'].includes(h.trim().toLowerCase()));
    const nameCol  = headers.find(h => ['name','party name','trade name','legal name','firm name','client name','taxpayer name'].includes(h.trim().toLowerCase()));

    if (!gstinCol) {
      return { error: `No "GSTIN" column found. Columns detected: ${headers.join(', ')}` };
    }

    const rows = rawData
      .map(row => ({
        gstin: String(row[gstinCol] || '').trim().toUpperCase(),
        email: emailCol ? String(row[emailCol] || '').trim() : '',
        name:  nameCol  ? String(row[nameCol]  || '').trim() : '',
      }))
      .filter(r => r.gstin.length > 0);

    if (rows.length === 0) return { error: 'GSTIN column found but no values.' };

    return { rows, total: rows.length, hasEmail: !!emailCol, hasName: !!nameCol };
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
