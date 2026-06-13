const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.CAPTCHA_DB
  || path.join(__dirname, '..', '..', 'data', 'captchas.db');

let db = null;
let insertStmt = null;
let disabled = false;

function init() {
  if (db || disabled) return db;
  try {
    // Lazy require — captcha logging is optional; app runs fine without it.
    const Database = require('better-sqlite3');
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS solved_captchas (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        username      TEXT,
        gstin         TEXT,
        captcha_text  TEXT NOT NULL,
        captcha_base64 TEXT NOT NULL
      );
    `);
    insertStmt = db.prepare(`
      INSERT INTO solved_captchas (username, gstin, captcha_text, captcha_base64)
      VALUES (@username, @gstin, @captchaText, @captchaBase64)
    `);
  } catch (err) {
    disabled = true;
    console.warn('[captcha-store] disabled:', err.message);
  }
  return db;
}

function saveSolvedCaptcha({ username, gstin, captchaText, captchaBase64 }) {
  if (!captchaText || !captchaBase64) return;
  try {
    init();
    if (disabled || !insertStmt) return;
    insertStmt.run({
      username: username || null,
      gstin: gstin || null,
      captchaText,
      captchaBase64,
    });
  } catch (err) {
    console.warn('[captcha-store] save failed:', err.message);
  }
}

function count() {
  try {
    init();
    if (disabled || !db) return 0;
    return db.prepare('SELECT COUNT(*) AS n FROM solved_captchas').get().n;
  } catch {
    return 0;
  }
}

module.exports = { saveSolvedCaptcha, count, DB_PATH };
