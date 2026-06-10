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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS visits (
        country_code TEXT PRIMARY KEY,
        country_name TEXT,
        count INTEGER DEFAULT 0
      );
    `);
    // Прогнози - всяка прогноза, която AI прави (за самообучение и статистика)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS predictions (
        fixture_id BIGINT PRIMARY KEY,
        home_team TEXT,
        away_team TEXT,
        league TEXT,
        match_date TIMESTAMP,
        prob_home INTEGER,
        prob_draw INTEGER,
        prob_away INTEGER,
        predicted TEXT,
        confidence INTEGER,
        actual_home INTEGER,
        actual_away INTEGER,
        actual_result TEXT,
        correct BOOLEAN,
        checked BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // Тежести за самообучението (как AI претегля факторите)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_weights (
        id INTEGER PRIMARY KEY DEFAULT 1,
        form_weight REAL DEFAULT 1.0,
        home_advantage REAL DEFAULT 1.0,
        goals_weight REAL DEFAULT 1.0,
        h2h_weight REAL DEFAULT 1.0,
        total_checked INTEGER DEFAULT 0,
        total_correct INTEGER DEFAULT 0
      );
    `);
    // вкарваме начален ред за тежестите, ако липсва
    await pool.query(`INSERT INTO ai_weights (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);
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
    id: f.fixture.id, league: f.league.name, leagueId: f.league.id, flag: f.league.flag,
    date: f.fixture.date, status: status, elapsed: f.fixture.status.elapsed,
    isLive: isLive, isFinished: isFinished,
    home: { name: f.teams.home.name, logo: f.teams.home.logo, goals: f.goals.home },
    away: { name: f.teams.away.name, logo: f.teams.away.logo, goals: f.goals.away }
  };
}

// ---------- Засичане на държава по IP + броене на посещение ----------
async function recordVisit(req) {
  try {
    // взимаме реалния IP (Render праща X-Forwarded-For)
    const fwd = req.headers['x-forwarded-for'];
    const ip = fwd ? fwd.split(',')[0].trim() : (req.socket.remoteAddress || '');
    if (!ip || ip.startsWith('127.') || ip === '::1') return; // локален - пропускаме

    // безплатно засичане на държава
    const geoRes = await fetch('https://ipapi.co/' + ip + '/json/');
    if (!geoRes.ok) return;
    const geo = await geoRes.json();
    const code = geo.country_code || 'XX';
    const name = geo.country_name || 'Unknown';

    // увеличаваме брояча за тази държава (UPSERT)
    await pool.query(
      `INSERT INTO visits (country_code, country_name, count) VALUES ($1, $2, 1)
       ON CONFLICT (country_code) DO UPDATE SET count = visits.count + 1, country_name = $2`,
      [code, name]
    );
  } catch (err) {
    // тихо - посещенията не са критични
  }
}

// ---------- Помощни за AI прогноза ----------

// Намира отбор по име, връща {id, name, logo} или null
async function findTeam(name) {
  const data = await apiFetch('/teams?search=' + encodeURIComponent(name));
  const t = (data.response || [])[0];
  if (!t) return null;
  return { id: t.team.id, name: t.team.name, logo: t.team.logo, country: t.team.country, founded: t.team.founded };
}

// Тегли последните N мача на отбор и смята форма
async function getTeamForm(teamId, count) {
  const n = count || 5;
  const data = await apiFetch('/fixtures?team=' + teamId + '&last=' + n);
  const fixtures = data.response || [];
  let wins = 0, draws = 0, losses = 0, goalsFor = 0, goalsAgainst = 0;
  const formStr = [];
  const recent = [];

  fixtures.forEach(f => {
    const isHome = f.teams.home.id === teamId;
    const gf = isHome ? f.goals.home : f.goals.away;
    const ga = isHome ? f.goals.away : f.goals.home;
    if (gf == null || ga == null) return;
    goalsFor += gf; goalsAgainst += ga;
    let result;
    if (gf > ga) { wins++; result = 'W'; }
    else if (gf < ga) { losses++; result = 'L'; }
    else { draws++; result = 'D'; }
    formStr.push(result);
    const opp = isHome ? f.teams.away : f.teams.home;
    recent.push({
      opponent: opp.name, isHome: isHome,
      score: gf + '-' + ga, result: result, date: f.fixture.date
    });
  });

  const played = wins + draws + losses;
  return {
    played, wins, draws, losses, goalsFor, goalsAgainst,
    form: formStr.join(''),
    avgScored: played ? (goalsFor / played) : 0,
    avgConceded: played ? (goalsAgainst / played) : 0,
    // точки от форма: победа=3, равен=1
    points: wins * 3 + draws,
    recent: recent
  };
}

// Директни срещи между два отбора
async function getH2H(id1, id2, count) {
  const n = count || 5;
  const data = await apiFetch('/fixtures/headtohead?h2h=' + id1 + '-' + id2 + '&last=' + n);
  const fixtures = data.response || [];
  let team1Wins = 0, team2Wins = 0, draws = 0;
  const matches = [];
  fixtures.forEach(f => {
    const h = f.goals.home, a = f.goals.away;
    if (h == null || a == null) return;
    const homeId = f.teams.home.id;
    let winnerId = null;
    if (h > a) winnerId = homeId;
    else if (a > h) winnerId = f.teams.away.id;
    if (winnerId === id1) team1Wins++;
    else if (winnerId === id2) team2Wins++;
    else draws++;
    matches.push({
      home: f.teams.home.name, away: f.teams.away.name,
      score: h + '-' + a, date: f.fixture.date
    });
  });
  return { total: matches.length, team1Wins, team2Wins, draws, matches };
}

// Изчислява прогноза от реалните данни (безплатна формула, с тежести за самообучение)
function computePrediction(home, away, h2h, weights) {
  // тежести по подразбиране (ако няма обучени)
  const w = weights || { form_weight: 1.0, home_advantage: 1.0, goals_weight: 1.0, h2h_weight: 1.0 };

  // Силов рейтинг: форма (точки) + голова разлика * тегло, с домакинско предимство * тегло
  const homeGoalDiff = (home.avgScored - home.avgConceded) * 2 * w.goals_weight;
  const awayGoalDiff = (away.avgScored - away.avgConceded) * 2 * w.goals_weight;
  const homeStrength = home.points * w.form_weight + homeGoalDiff + 1.2 * w.home_advantage;
  const awayStrength = away.points * w.form_weight + awayGoalDiff;

  // H2H бонус * тегло
  let homeH2H = 0, awayH2H = 0;
  if (h2h && h2h.total > 0) {
    homeH2H = h2h.team1Wins * 0.8 * w.h2h_weight;
    awayH2H = h2h.team2Wins * 0.8 * w.h2h_weight;
  }

  const homeScore = Math.max(0.1, homeStrength + homeH2H);
  const awayScore = Math.max(0.1, awayStrength + awayH2H);

  // Базови вероятности
  const total = homeScore + awayScore;
  let pHome = homeScore / total;
  let pAway = awayScore / total;

  // Дял за равенство според близостта на силите
  const closeness = 1 - Math.abs(pHome - pAway);
  const pDraw = 0.18 + closeness * 0.14;

  const scale = (1 - pDraw);
  pHome = pHome * scale;
  pAway = pAway * scale;

  const homePct = Math.round(pHome * 100);
  const awayPct = Math.round(pAway * 100);
  const drawPct = 100 - homePct - awayPct;

  const expHomeGoals = (home.avgScored + away.avgConceded) / 2;
  const expAwayGoals = (away.avgScored + home.avgConceded) / 2;
  const expTotal = expHomeGoals + expAwayGoals;

  let pick, pickType;
  if (homePct > awayPct && homePct > drawPct) { pick = home.name; pickType = '1'; }
  else if (awayPct > homePct && awayPct > drawPct) { pick = away.name; pickType = '2'; }
  else { pick = 'X'; pickType = 'X'; }

  const over25 = expTotal > 2.5;
  const bttsLikely = expHomeGoals > 0.9 && expAwayGoals > 0.9;

  return {
    homePct, drawPct, awayPct,
    pick, pickType,
    expHomeGoals: Math.round(expHomeGoals * 10) / 10,
    expAwayGoals: Math.round(expAwayGoals * 10) / 10,
    expTotalGoals: Math.round(expTotal * 10) / 10,
    over25, bttsLikely,
    confidence: Math.max(homePct, drawPct, awayPct)
  };
}

// Чете тежестите на AI от базата
async function getWeights() {
  try {
    const r = await pool.query('SELECT * FROM ai_weights WHERE id = 1');
    return r.rows[0] || null;
  } catch (e) { return null; }
}

// Записва прогноза в базата (за самообучение и статистика)
async function savePrediction(fixtureId, homeTeam, awayTeam, league, matchDate, pred) {
  try {
    await pool.query(
      `INSERT INTO predictions (fixture_id, home_team, away_team, league, match_date, prob_home, prob_draw, prob_away, predicted, confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (fixture_id) DO NOTHING`,
      [fixtureId, homeTeam, awayTeam, league, matchDate, pred.homePct, pred.drawPct, pred.awayPct, pred.pickType, pred.confidence]
    );
  } catch (e) { /* тихо */ }
}

// Проверява свършилите мачове и учи от тях (самообучение)
let lastLearnTime = 0;
async function checkAndLearn() {
  // не по-често от веднъж на 10 мин
  if (Date.now() - lastLearnTime < 600000) return;
  lastLearnTime = Date.now();
  try {
    // взимаме непроверени прогнози за мачове, които вече трябва да са свършили
    const pending = await pool.query(
      `SELECT * FROM predictions WHERE checked = false AND match_date < NOW() - INTERVAL '2 hours' LIMIT 20`
    );
    if (pending.rows.length === 0) return;

    let correctDelta = 0, checkedDelta = 0;
    for (const p of pending.rows) {
      // питаме API за резултата
      let fx;
      try {
        const data = await apiFetch('/fixtures?id=' + p.fixture_id);
        fx = (data.response || [])[0];
      } catch (e) { continue; }
      if (!fx) continue;
      const status = fx.fixture.status.short;
      if (!['FT','AET','PEN'].includes(status)) continue; // още не е свършил

      const gh = fx.goals.home, ga = fx.goals.away;
      let actualResult = 'X';
      if (gh > ga) actualResult = '1';
      else if (ga > gh) actualResult = '2';
      const correct = (p.predicted === actualResult);

      await pool.query(
        `UPDATE predictions SET actual_home=$1, actual_away=$2, actual_result=$3, correct=$4, checked=true WHERE fixture_id=$5`,
        [gh, ga, actualResult, correct, p.fixture_id]
      );
      checkedDelta++;
      if (correct) correctDelta++;
    }

    if (checkedDelta > 0) {
      // обновяваме общата статистика
      await pool.query(
        `UPDATE ai_weights SET total_checked = total_checked + $1, total_correct = total_correct + $2 WHERE id = 1`,
        [checkedDelta, correctDelta]
      );
      // самообучение: ако точността е ниска, леко коригираме тежестите
      const wq = await pool.query('SELECT * FROM ai_weights WHERE id = 1');
      const w = wq.rows[0];
      if (w && w.total_checked >= 20) {
        const accuracy = w.total_correct / w.total_checked;
        // ако сме под 50%, засилваме формата (най-важният фактор); ако над 60%, стабилизираме
        if (accuracy < 0.5) {
          await pool.query(`UPDATE ai_weights SET form_weight = LEAST(form_weight + 0.05, 2.0), home_advantage = LEAST(home_advantage + 0.03, 2.0) WHERE id = 1`);
        }
      }
    }
  } catch (e) { /* тихо */ }
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

    // Тестов endpoint - мачове от стар сезон (за проверка на безплатния план)
    if (route === '/api/test') {
      if (!API_KEY) return sendJSON(res, 500, { error: 'no_key' });
      // Висша лига (league=39), сезон 2021, кръг 1 - достъпно в безплатния план
      const data = await apiFetch('/fixtures?league=39&season=2021&from=2021-08-13&to=2021-08-16');
      const matches = (data.response || []).map(simplifyFixture);
      return sendJSON(res, 200, {
        info: 'Тестови данни от стар сезон 2021',
        rawResults: data.results,
        rawErrors: data.errors,
        count: matches.length,
        matches: matches
      });
    }

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

    // ---------- ПОДРОБНОСТИ ЗА МАЧ (събития + статистика) ----------
    if (route === '/api/match') {
      if (!API_KEY) return sendJSON(res, 500, { error: 'no_key' });
      // извличаме id директно от req.url (тук няма променлива url)
      const reqUrl = new URL(req.url, 'http://' + req.headers.host);
      const id = reqUrl.searchParams.get('id');
      if (!id) return sendJSON(res, 400, { error: 'missing_id' });

      // кеш 20 сек (живите мачове се менят често)
      const cacheKey = 'match:' + id;
      const cached = getCached(cacheKey, 20000);
      if (cached) return sendJSON(res, 200, cached);

      // основни данни + събития + статистика паралелно
      const [fxData, evData, statData] = await Promise.all([
        apiFetch('/fixtures?id=' + id).catch(() => ({ response: [] })),
        apiFetch('/fixtures/events?fixture=' + id).catch(() => ({ response: [] })),
        apiFetch('/fixtures/statistics?fixture=' + id).catch(() => ({ response: [] }))
      ]);

      const fx = (fxData.response || [])[0];
      if (!fx) return sendJSON(res, 404, { error: 'match_not_found' });

      // Събития (голове, картони, смени) - със защита срещу липсващи полета
      const events = (evData.response || []).map(e => {
        const time = e.time || {};
        const team = e.team || {};
        return {
          minute: time.elapsed != null ? time.elapsed : null,
          extra: time.extra != null ? time.extra : null,
          type: e.type || '',
          detail: e.detail || '',
          team: team.name || '',
          teamId: team.id || null,
          player: e.player ? e.player.name : null,
          assist: e.assist ? e.assist.name : null
        };
      });

      // Статистика по отбор -> правим я лесна за ползване (със защита)
      const stats = {};
      (statData.response || []).forEach(teamStat => {
        if (!teamStat || !teamStat.team) return;
        const tid = teamStat.team.id;
        stats[tid] = {};
        (teamStat.statistics || []).forEach(s => {
          if (s && s.type != null) stats[tid][s.type] = s.value;
        });
      });

      // Владение като числа (за сянката)
      const teams = fx.teams || {};
      const homeTeam = teams.home || {};
      const awayTeam = teams.away || {};
      const homeId = homeTeam.id;
      const awayId = awayTeam.id;
      const goals = fx.goals || {};
      const fixture = fx.fixture || {};
      const status = fixture.status || {};
      const league = fx.league || {};

      const parsePoss = (v) => {
        if (v == null) return null;
        const n = parseInt(String(v).replace('%', ''));
        return isNaN(n) ? null : n;
      };
      let homePoss = stats[homeId] ? parsePoss(stats[homeId]['Ball Possession']) : null;
      let awayPoss = stats[awayId] ? parsePoss(stats[awayId]['Ball Possession']) : null;

      const result = {
        id: fixture.id,
        league: league.name || '',
        status: status.short || '',
        elapsed: status.elapsed != null ? status.elapsed : null,
        home: { id: homeId, name: homeTeam.name || '', logo: homeTeam.logo || '', goals: goals.home != null ? goals.home : 0, possession: homePoss },
        away: { id: awayId, name: awayTeam.name || '', logo: awayTeam.logo || '', goals: goals.away != null ? goals.away : 0, possession: awayPoss },
        events: events,
        stats: { home: stats[homeId] || {}, away: stats[awayId] || {} }
      };
      setCached(cacheKey, result);
      return sendJSON(res, 200, result);
    }

    // ---------- ЛИГИ С ЖИВИ МАЧОВЕ (за филтъра) ----------
    if (route === '/api/leagues-live') {
      if (!API_KEY) return sendJSON(res, 500, { error: 'no_key' });
      const cached = getCached('leagues-live', 30000);
      if (cached) return sendJSON(res, 200, cached);
      const data = await apiFetch('/fixtures?live=all');
      const matches = (data.response || []).map(simplifyFixture);
      // групираме по лига
      const leaguesMap = {};
      matches.forEach(m => {
        if (m.leagueId == null) return;
        if (!leaguesMap[m.leagueId]) {
          leaguesMap[m.leagueId] = { id: m.leagueId, name: m.league, flag: m.flag, count: 0 };
        }
        leaguesMap[m.leagueId].count++;
      });
      const leagues = Object.values(leaguesMap).sort((a, b) => b.count - a.count);
      const result = { total: matches.length, leagues: leagues };
      setCached('leagues-live', result);
      return sendJSON(res, 200, result);
    }

    // ---------- ПОСЕЩЕНИЯ ПО ДЪРЖАВИ + PRO АКАУНТИ ----------
    if (route === '/api/visits') {
      try {
        const visitsRes = await pool.query(
          'SELECT country_code, country_name, count FROM visits ORDER BY count DESC LIMIT 12'
        );
        const totalRes = await pool.query('SELECT COALESCE(SUM(count),0) AS total FROM visits');
        const proRes = await pool.query('SELECT COUNT(*) AS pro FROM users WHERE is_pro = true');
        return sendJSON(res, 200, {
          countries: visitsRes.rows,
          total: parseInt(totalRes.rows[0].total) || 0,
          proAccounts: parseInt(proRes.rows[0].pro) || 0
        });
      } catch (err) {
        return sendJSON(res, 200, { countries: [], total: 0, proAccounts: 0 });
      }
    }

    // ---------- ПОДСКАЗВАЧ: търсене на отбори по име ----------
    if (route === '/api/search-team') {
      if (!API_KEY) return sendJSON(res, 500, { error: 'no_key' });
      const reqUrl = new URL(req.url, 'http://' + req.headers.host);
      const q = (reqUrl.searchParams.get('q') || '').trim();
      if (q.length < 3) return sendJSON(res, 200, { teams: [] });

      const cacheKey = 'search:' + q.toLowerCase();
      const cached = getCached(cacheKey, 3600000); // 1 час
      if (cached) return sendJSON(res, 200, cached);

      try {
        const data = await apiFetch('/teams?search=' + encodeURIComponent(q));
        const teams = (data.response || []).slice(0, 8).map(t => ({
          name: t.team.name,
          logo: t.team.logo,
          country: t.team.country
        }));
        const result = { teams: teams };
        setCached(cacheKey, result);
        return sendJSON(res, 200, result);
      } catch (err) {
        return sendJSON(res, 200, { teams: [] });
      }
    }

    // ---------- СТАТИСТИКА ЗА ЕДИН ОТБОР ----------
    if (route === '/api/team-stats' && method === 'POST') {
      if (!API_KEY) return sendJSON(res, 500, { error: 'no_key' });
      const body = await readBody(req);
      const teamName = (body.team || '').trim();
      if (!teamName) return sendJSON(res, 400, { error: 'no_team' });

      const cacheKey = 'teamstats:' + teamName.toLowerCase();
      const cached = getCached(cacheKey, 600000); // 10 мин
      if (cached) return sendJSON(res, 200, cached);

      // намираме отбора
      const team = await findTeam(teamName);
      if (!team) return sendJSON(res, 404, { error: 'team_not_found' });

      // взимаме формата от последните 10 мача
      const form = await getTeamForm(team.id, 10);

      const result = {
        team: { id: team.id, name: team.name, logo: team.logo, country: team.country, founded: team.founded },
        stats: {
          played: form.played,
          wins: form.wins,
          draws: form.draws,
          losses: form.losses,
          goalsFor: form.goalsFor,
          goalsAgainst: form.goalsAgainst,
          goalDiff: form.goalsFor - form.goalsAgainst,
          avgScored: Math.round(form.avgScored * 100) / 100,
          avgConceded: Math.round(form.avgConceded * 100) / 100,
          form: form.form,
          points: form.points
        },
        recent: form.recent
      };
      setCached(cacheKey, result);
      return sendJSON(res, 200, result);
    }

    // ---------- AI ПРОГНОЗА (безплатна формула) ----------
    // ---------- ДИРЕКТНИ СРЕЩИ (H2H) ----------
    if (route === '/api/h2h' && method === 'POST') {
      if (!API_KEY) return sendJSON(res, 500, { error: 'no_key' });
      const body = await readBody(req);
      const homeName = (body.home || '').trim();
      const awayName = (body.away || '').trim();
      if (!homeName || !awayName) return sendJSON(res, 400, { error: 'missing_teams' });

      const cacheKey = 'h2h:' + homeName.toLowerCase() + ':' + awayName.toLowerCase();
      const cached = getCached(cacheKey, 600000);
      if (cached) return sendJSON(res, 200, cached);

      const team1 = await findTeam(homeName);
      if (!team1) return sendJSON(res, 404, { error: 'home_not_found', name: homeName });
      const team2 = await findTeam(awayName);
      if (!team2) return sendJSON(res, 404, { error: 'away_not_found', name: awayName });

      const h2h = await getH2H(team1.id, team2.id, 10);
      const result = {
        team1: { id: team1.id, name: team1.name, logo: team1.logo },
        team2: { id: team2.id, name: team2.name, logo: team2.logo },
        h2h: h2h
      };
      setCached(cacheKey, result);
      return sendJSON(res, 200, result);
    }

    // ---------- ГОЛОВА СТАТИСТИКА ----------
    if (route === '/api/goals' && method === 'POST') {
      if (!API_KEY) return sendJSON(res, 500, { error: 'no_key' });
      const body = await readBody(req);
      const teamName = (body.team || '').trim();
      if (!teamName) return sendJSON(res, 400, { error: 'no_team' });

      const cacheKey = 'goals:' + teamName.toLowerCase();
      const cached = getCached(cacheKey, 600000);
      if (cached) return sendJSON(res, 200, cached);

      const team = await findTeam(teamName);
      if (!team) return sendJSON(res, 404, { error: 'team_not_found' });

      // последните 10 мача за голов анализ
      const data = await apiFetch('/fixtures?team=' + team.id + '&last=10');
      const fixtures = data.response || [];
      let over25 = 0, under25 = 0, btts = 0, cleanSheets = 0, failedToScore = 0;
      let totalGoals = 0, scoredFirst = 0, counted = 0;

      fixtures.forEach(f => {
        const isHome = f.teams.home.id === team.id;
        const gf = isHome ? f.goals.home : f.goals.away;
        const ga = isHome ? f.goals.away : f.goals.home;
        if (gf == null || ga == null) return;
        counted++;
        const matchGoals = gf + ga;
        totalGoals += matchGoals;
        if (matchGoals > 2.5) over25++; else under25++;
        if (gf > 0 && ga > 0) btts++;
        if (ga === 0) cleanSheets++;
        if (gf === 0) failedToScore++;
      });

      const pct = (n) => counted ? Math.round((n / counted) * 100) : 0;
      const result = {
        team: { id: team.id, name: team.name, logo: team.logo, country: team.country },
        goals: {
          played: counted,
          avgTotal: counted ? Math.round((totalGoals / counted) * 100) / 100 : 0,
          over25: pct(over25), under25: pct(under25),
          btts: pct(btts), cleanSheets: pct(cleanSheets),
          failedToScore: pct(failedToScore)
        }
      };
      setCached(cacheKey, result);
      return sendJSON(res, 200, result);
    }

    // ---------- КОЕФИЦИЕНТИ ----------
    if (route === '/api/odds') {
      if (!API_KEY) return sendJSON(res, 500, { error: 'no_key' });
      const reqUrl = new URL(req.url, 'http://' + req.headers.host);
      const fixtureId = reqUrl.searchParams.get('fixture');
      if (!fixtureId) return sendJSON(res, 400, { error: 'missing_fixture' });

      const cacheKey = 'odds:' + fixtureId;
      const cached = getCached(cacheKey, 300000); // 5 мин
      if (cached) return sendJSON(res, 200, cached);

      try {
        const data = await apiFetch('/odds?fixture=' + fixtureId);
        const resp = (data.response || [])[0];
        if (!resp || !resp.bookmakers || resp.bookmakers.length === 0) {
          return sendJSON(res, 200, { available: false });
        }
        // взимаме първия букмейкър и пазара "Match Winner"
        const bm = resp.bookmakers[0];
        const matchWinner = (bm.bets || []).find(b => b.name === 'Match Winner');
        let odds = null;
        if (matchWinner) {
          const vals = matchWinner.values || [];
          odds = {
            home: (vals.find(v => v.value === 'Home') || {}).odd || null,
            draw: (vals.find(v => v.value === 'Draw') || {}).odd || null,
            away: (vals.find(v => v.value === 'Away') || {}).odd || null
          };
        }
        const result = { available: !!odds, bookmaker: bm.name, odds: odds };
        setCached(cacheKey, result);
        return sendJSON(res, 200, result);
      } catch (err) {
        return sendJSON(res, 200, { available: false });
      }
    }

    // ---------- КОНТУЗИИ ----------
    if (route === '/api/injuries') {
      if (!API_KEY) return sendJSON(res, 500, { error: 'no_key' });
      const reqUrl = new URL(req.url, 'http://' + req.headers.host);
      const fixtureId = reqUrl.searchParams.get('fixture');
      if (!fixtureId) return sendJSON(res, 400, { error: 'missing_fixture' });

      const cacheKey = 'injuries:' + fixtureId;
      const cached = getCached(cacheKey, 600000);
      if (cached) return sendJSON(res, 200, cached);

      try {
        const data = await apiFetch('/injuries?fixture=' + fixtureId);
        const players = (data.response || []).map(i => ({
          player: i.player ? i.player.name : '',
          team: i.team ? i.team.name : '',
          reason: i.player ? i.player.reason : '',
          type: i.player ? i.player.type : ''
        }));
        const result = { count: players.length, players: players };
        setCached(cacheKey, result);
        return sendJSON(res, 200, result);
      } catch (err) {
        return sendJSON(res, 200, { count: 0, players: [] });
      }
    }

    if (route === '/api/predict' && method === 'POST') {
      if (!API_KEY) return sendJSON(res, 500, { error: 'no_key' });
      const body = await readBody(req);
      const homeName = (body.home || '').trim();
      const awayName = (body.away || '').trim();
      if (!homeName || !awayName) return sendJSON(res, 400, { error: 'missing_teams' });

      // кеш по двойката отбори (за 10 мин), за да пестим заявки
      const cacheKey = 'predict:' + homeName.toLowerCase() + ':' + awayName.toLowerCase();
      const cached = getCached(cacheKey, 600000);
      if (cached) return sendJSON(res, 200, cached);

      // 1) Намираме двата отбора
      const homeTeam = await findTeam(homeName);
      if (!homeTeam) return sendJSON(res, 404, { error: 'home_not_found', name: homeName });
      const awayTeam = await findTeam(awayName);
      if (!awayTeam) return sendJSON(res, 404, { error: 'away_not_found', name: awayName });

      // 2) Тегли форма и директни срещи
      const [homeForm, awayForm, h2h] = await Promise.all([
        getTeamForm(homeTeam.id, 5),
        getTeamForm(awayTeam.id, 5),
        getH2H(homeTeam.id, awayTeam.id, 5)
      ]);

      // 3) Смятаме прогнозата (с обучените тежести)
      const weights = await getWeights();
      const prediction = computePrediction(
        Object.assign({ name: homeTeam.name }, homeForm),
        Object.assign({ name: awayTeam.name }, awayForm),
        h2h,
        weights
      );

      const result = {
        home: { id: homeTeam.id, name: homeTeam.name, logo: homeTeam.logo, country: homeTeam.country, form: homeForm },
        away: { id: awayTeam.id, name: awayTeam.name, logo: awayTeam.logo, country: awayTeam.country, form: awayForm },
        h2h: h2h,
        prediction: prediction
      };
      setCached(cacheKey, result);
      // проверяваме минали мачове за самообучение (фоново)
      checkAndLearn();
      return sendJSON(res, 200, result);
    }

    // ---------- МОИТЕ ПРОГНОЗИ (реална статистика на AI) ----------
    if (route === '/api/my-predictions') {
      try {
        const w = await pool.query('SELECT total_checked, total_correct FROM ai_weights WHERE id = 1');
        const total = w.rows[0] ? w.rows[0].total_checked : 0;
        const correct = w.rows[0] ? w.rows[0].total_correct : 0;
        const accuracy = total > 0 ? Math.round((correct / total) * 1000) / 10 : 0;

        // тази седмица
        const week = await pool.query(
          `SELECT COUNT(*) FILTER (WHERE correct = true) AS correct, COUNT(*) AS total
           FROM predictions WHERE checked = true AND created_at > NOW() - INTERVAL '7 days'`
        );
        const weekCorrect = parseInt(week.rows[0].correct) || 0;
        const weekTotal = parseInt(week.rows[0].total) || 0;

        // серия (последователни познати)
        const recent = await pool.query(
          `SELECT correct FROM predictions WHERE checked = true ORDER BY match_date DESC LIMIT 20`
        );
        let streak = 0;
        for (const row of recent.rows) {
          if (row.correct) streak++; else break;
        }

        return sendJSON(res, 200, {
          weekCorrect, weekTotal,
          totalChecked: total, totalCorrect: correct, accuracy,
          streak
        });
      } catch (e) {
        return sendJSON(res, 200, { weekCorrect: 0, weekTotal: 0, totalChecked: 0, totalCorrect: 0, accuracy: 0, streak: 0 });
      }
    }

    // ---------- СИГУРНИ ЗАЛОЗИ (висока увереност, предстоящи + живи) ----------
    if (route === '/api/sure-bets') {
      if (!API_KEY) return sendJSON(res, 500, { error: 'no_key' });
      const cached = getCached('sure-bets', 300000); // 5 мин
      if (cached) return sendJSON(res, 200, cached);

      try {
        const weights = await getWeights();
        // взимаме живи + днешни мачове
        const [liveData, todayData] = await Promise.all([
          apiFetch('/fixtures?live=all').catch(() => ({ response: [] })),
          apiFetch('/fixtures?date=' + new Date().toISOString().slice(0,10)).catch(() => ({ response: [] }))
        ]);
        let fixtures = [...(liveData.response || []), ...(todayData.response || [])];
        // махаме дубликати по id
        const seen = {};
        fixtures = fixtures.filter(f => { if (seen[f.fixture.id]) return false; seen[f.fixture.id] = 1; return true; });
        // ограничаваме до 25 за да не правим твърде много заявки
        fixtures = fixtures.slice(0, 25);

        const sureBets = [];
        for (const f of fixtures) {
          const status = f.fixture.status.short;
          // само предстоящи или живи (не свършили)
          if (['FT','AET','PEN','PST','CANC'].includes(status)) continue;
          try {
            const [hForm, aForm] = await Promise.all([
              getTeamForm(f.teams.home.id, 5),
              getTeamForm(f.teams.away.id, 5)
            ]);
            const pred = computePrediction(
              Object.assign({ name: f.teams.home.name }, hForm),
              Object.assign({ name: f.teams.away.name }, aForm),
              null, weights
            );
            // "сигурен" = увереност >= 60% и достатъчно данни
            if (pred.confidence >= 60 && hForm.played >= 3 && aForm.played >= 3) {
              const isLive = ['1H','HT','2H','ET','BT','P','LIVE'].includes(status);
              sureBets.push({
                fixtureId: f.fixture.id,
                league: f.league.name, flag: f.league.flag,
                home: f.teams.home.name, away: f.teams.away.name,
                homeLogo: f.teams.home.logo, awayLogo: f.teams.away.logo,
                date: f.fixture.date, isLive,
                pick: pred.pick, pickType: pred.pickType,
                confidence: pred.confidence,
                homePct: pred.homePct, drawPct: pred.drawPct, awayPct: pred.awayPct
              });
              // записваме прогнозата за самообучение
              savePrediction(f.fixture.id, f.teams.home.name, f.teams.away.name, f.league.name, f.fixture.date, pred);
            }
          } catch (e) { continue; }
          if (sureBets.length >= 10) break; // максимум 10
        }
        // подреждаме по увереност
        sureBets.sort((a, b) => b.confidence - a.confidence);
        const result = { count: sureBets.length, bets: sureBets };
        setCached('sure-bets', result);
        checkAndLearn();
        return sendJSON(res, 200, result);
      } catch (e) {
        return sendJSON(res, 200, { count: 0, bets: [] });
      }
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
  // броим посещение само при зареждане на главната страница
  if (route === '/' || route === '/index.html') {
    recordVisit(req); // не чакаме - върви фоново
  }
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
