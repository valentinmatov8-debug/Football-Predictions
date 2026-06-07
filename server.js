// ============================================================
//  GoalMind — сървър с база данни, регистрация и вход
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = 'https://v3.football.api-sports.io';
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- База данни (PostgreSQL от Render) ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Създаваме таблиците при стартиране, ако ги няма
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        username TEXT,
        password_hash TEXT NOT NULL,
        is_pro BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✓ Базата данни е готова');
  } catch (err) {
    console.error('Грешка при създаване на таблиците:', err.message);
  }
}

// ---------- Кеш за API ----------
const cache = {};
function getCached(key, maxAgeMs) {
  const e = cache[key];
  if (e && (Date.now() - e.time) < maxAgeMs) return e.data;
  return null;
}
function setCached(key, data) { cache[key] = { data, time: Date.now() }; }

async function apiFetch(endpoint) {
  const res = await fetch(API_BASE + endpoint, { headers: { 'x-apisports-key': API_KEY } });
  if (!res.ok) throw new Error('API ' + res.status);
  return res.json();
}

function simplifyFixture(f) {
  const status = f.fixture.status.short;
  const isLive = ['1H','HT','2H','ET','BT','P','LIVE'].includes(status);
  const isFinished = ['FT','AET','PEN'].includes(status);
  return {
    id: f.fixture.id, league: f.league.name, flag: f.league.flag,
    date: f.fixture.date, status: status, elapsed: f.fixture.status.elapsed,
    isLive: isLive, isFinished: isFinished,
    home: { name: f.teams.home.name, logo: f.teams.home.logo, goals: f.goals.home },
    away: { name: f.teams.away.name, logo: f.teams.away.logo, goals: f.goals.away }
  };
}

// ---------- Помощни ----------
function sendJSON(res, code, obj, headers) {
  const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {});
  res.writeHead(code, h);
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { resolve({}); }
    });
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function validEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// Връща текущия потребител от сесийния cookie (или null)
async function getCurrentUser(req) {
  const cookies = parseCookies(req);
  const token = cookies.session;
  if (!token) return null;
  try {
    const r = await pool.query(
      `SELECT u.id, u.email, u.username, u.is_pro
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = $1`, [token]);
    return r.rows[0] || null;
  } catch { return null; }
}

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg',
  '.svg':'image/svg+xml', '.ico':'image/x-icon', '.json':'application/json'
};

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR,'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}


// ============================================================
//   API заявки
// ============================================================
async function handleApi(req, res, route, method) {
  try {
    // ---------- РЕГИСТРАЦИЯ ----------
    if (route === '/api/register' && method === 'POST') {
      const body = await readBody(req);
      const email = (body.email || '').trim().toLowerCase();
      const password = body.password || '';
      const username = (body.username || '').trim();

      if (!validEmail(email)) return sendJSON(res, 400, { error: 'invalid_email' });
      if (password.length < 6) return sendJSON(res, 400, { error: 'weak_password' });

      // проверка дали имейлът вече съществува
      const exist = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      if (exist.rows.length > 0) return sendJSON(res, 409, { error: 'email_taken' });

      const hash = await bcrypt.hash(password, 10);
      const r = await pool.query(
        'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id, email, username, is_pro',
        [email, username || null, hash]);
      const user = r.rows[0];

      // създаваме сесия
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, user.id]);

      const cookie = `session=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax; Secure`;
      return sendJSON(res, 200, { user: user }, { 'Set-Cookie': cookie });
    }

    // ---------- ВХОД ----------
    if (route === '/api/login' && method === 'POST') {
      const body = await readBody(req);
      const email = (body.email || '').trim().toLowerCase();
      const password = body.password || '';

      const r = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
      const user = r.rows[0];
      if (!user) return sendJSON(res, 401, { error: 'invalid_credentials' });

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return sendJSON(res, 401, { error: 'invalid_credentials' });

      const token = crypto.randomBytes(32).toString('hex');
      await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, user.id]);

      const cookie = `session=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax; Secure`;
      return sendJSON(res, 200, {
        user: { id: user.id, email: user.email, username: user.username, is_pro: user.is_pro }
      }, { 'Set-Cookie': cookie });
    }

    // ---------- ИЗХОД ----------
    if (route === '/api/logout' && method === 'POST') {
      const cookies = parseCookies(req);
      if (cookies.session) {
        await pool.query('DELETE FROM sessions WHERE token = $1', [cookies.session]);
      }
      const cookie = 'session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure';
      return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': cookie });
    }

    // ---------- ТЕКУЩ ПОТРЕБИТЕЛ ----------
    if (route === '/api/me' && method === 'GET') {
      const user = await getCurrentUser(req);
      return sendJSON(res, 200, { user: user });
    }

    // ---------- БРОЙ PRO ПОТРЕБИТЕЛИ ----------
    if (route === '/api/stats' && method === 'GET') {
      const total = await pool.query('SELECT COUNT(*) FROM users');
      const pro = await pool.query('SELECT COUNT(*) FROM users WHERE is_pro = true');
      return sendJSON(res, 200, {
        totalUsers: parseInt(total.rows[0].count),
        proUsers: parseInt(pro.rows[0].count)
      });
    }

    // ---------- ФУТБОЛНИ ДАННИ ----------
    if (route === '/api/health') return sendJSON(res, 200, { ok: true, hasKey: !!API_KEY });

    if (route === '/api/live') {
      if (!API_KEY) return sendJSON(res, 500, { error: 'no_key' });
      const c = getCached('live', 20000); if (c) return sendJSON(res, 200, c);
      const data = await apiFetch('/fixtures?live=all');
      const matches = (data.response || []).map(simplifyFixture);
      const result = { count: matches.length, matches: matches };
      setCached('live', result); return sendJSON(res, 200, result);
    }
    if (route === '/api/today') {
      if (!API_KEY) return sendJSON(res, 500, { error: 'no_key' });
      const c = getCached('today', 300000); if (c) return sendJSON(res, 200, c);
      const today = new Date().toISOString().slice(0,10);
      const data = await apiFetch('/fixtures?date=' + today);
      const matches = (data.response || []).map(simplifyFixture);
      const result = { count: matches.length, matches: matches };
      setCached('today', result); return sendJSON(res, 200, result);
    }
    if (route === '/api/tomorrow') {
      if (!API_KEY) return sendJSON(res, 500, { error: 'no_key' });
      const c = getCached('tomorrow', 1800000); if (c) return sendJSON(res, 200, c);
      const d = new Date(); d.setDate(d.getDate()+1);
      const data = await apiFetch('/fixtures?date=' + d.toISOString().slice(0,10));
      const matches = (data.response || []).map(simplifyFixture);
      const result = { count: matches.length, matches: matches };
      setCached('tomorrow', result); return sendJSON(res, 200, result);
    }

    return sendJSON(res, 404, { error: 'not_found' });
  } catch (err) {
    console.error('API грешка (' + route + '):', err.message);
    return sendJSON(res, 500, { error: 'server_error' });
  }
}

// ============================================================
//   Стартиране на сървъра
// ============================================================
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const route = url.pathname;
  if (route.startsWith('/api/')) { handleApi(req, res, route, req.method); return; }
  let filePath = path.join(PUBLIC_DIR, route === '/' ? 'index.html' : route);
  if (!filePath.startsWith(PUBLIC_DIR)) filePath = path.join(PUBLIC_DIR, 'index.html');
  serveStatic(res, filePath);
});

initDatabase().then(() => {
  server.listen(PORT, () => {
    console.log('GoalMind сървърът работи на порт ' + PORT);
    if (!API_KEY) console.warn('⚠️  Липсва API_FOOTBALL_KEY');
    if (!process.env.DATABASE_URL) console.warn('⚠️  Липсва DATABASE_URL');
  });
});
