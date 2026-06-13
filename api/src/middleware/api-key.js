const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEYS_PATH = process.env.API_KEYS_FILE
  || path.join(__dirname, '..', '..', 'data', 'api-keys.txt');

let cache = { mtimeMs: -1, hashes: new Set() };

function loadHashes() {
  try {
    const st = fs.statSync(KEYS_PATH);
    if (st.mtimeMs !== cache.mtimeMs) {
      const hashes = new Set(
        fs.readFileSync(KEYS_PATH, 'utf8')
          .split('\n')
          .map((line) => line.trim().split(/\s+/)[0])
          .filter((h) => /^[a-f0-9]{64}$/i.test(h)),
      );
      cache = { mtimeMs: st.mtimeMs, hashes };
    }
  } catch {
    cache = { mtimeMs: -1, hashes: new Set() };
  }
  return cache.hashes;
}

function timingSafeHas(hashes, hashHex) {
  const candidate = Buffer.from(hashHex, 'hex');
  for (const stored of hashes) {
    const a = Buffer.from(stored, 'hex');
    if (a.length === candidate.length && crypto.timingSafeEqual(a, candidate)) return true;
  }
  return false;
}

function apiKeyAuth(req, res, next) {
  const hashes = loadHashes();
  if (hashes.size === 0) return next(); // no keys file → open (bundled local mode)

  const key = req.get('x-api-key') || '';
  if (!key) return res.status(401).json({ error: 'API key required (x-api-key header)' });

  const hashHex = crypto.createHash('sha256').update(key).digest('hex');
  if (timingSafeHas(hashes, hashHex)) return next();
  return res.status(401).json({ error: 'invalid API key' });
}

module.exports = { apiKeyAuth, KEYS_PATH };
