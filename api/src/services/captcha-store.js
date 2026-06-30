const path = require('path');
const fs   = require('fs');

const STORE_PATH = process.env.CAPTCHA_DB
  ? process.env.CAPTCHA_DB.replace(/\.db$/, '.jsonl')
  : path.join(__dirname, '..', '..', 'data', 'captchas.jsonl');

// Expose DB_PATH alias so existing callers referencing DB_PATH still work
const DB_PATH = STORE_PATH;

let ready = false;

function ensureDir() {
  if (ready) return;
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    ready = true;
  } catch (err) {
    console.warn('[captcha-store] could not create data dir:', err.message);
  }
}

function saveSolvedCaptcha({ username, gstin, captchaText, captchaBase64 }) {
  if (!captchaText || !captchaBase64) return;
  try {
    ensureDir();
    if (!ready) return;
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      username: username || null,
      gstin:    gstin    || null,
      captchaText,
      captchaBase64,
    });
    fs.appendFileSync(STORE_PATH, entry + '\n', 'utf8');
  } catch (err) {
    console.warn('[captcha-store] save failed:', err.message);
  }
}

function count() {
  try {
    if (!fs.existsSync(STORE_PATH)) return 0;
    const content = fs.readFileSync(STORE_PATH, 'utf8');
    return content.split('\n').filter(l => l.trim()).length;
  } catch {
    return 0;
  }
}

module.exports = { saveSolvedCaptcha, count, DB_PATH };
