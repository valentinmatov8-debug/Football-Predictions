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

// Изчислява прогноза от реалните данни (безплатна формула)
function computePrediction(home, away, h2h) {
  // Силов рейтинг: форма (точки от 5 мача) + голова разлика, с предимство за домакин
  const homeStrength = home.points + (home.avgScored - home.avgConceded) * 2 + 1.2; // +1.2 домакинско предимство
  const awayStrength = away.points + (away.avgScored - away.avgConceded) * 2;

  // H2H бонус
  let homeH2H = 0, awayH2H = 0;
  if (h2h && h2h.total > 0) {
    homeH2H = h2h.team1Wins * 0.8;
    awayH2H = h2h.team2Wins * 0.8;
  }

  const homeScore = Math.max(0.1, homeStrength + homeH2H);
  const awayScore = Math.max(0.1, awayStrength + awayH2H);

  // Базови вероятности
  const total = homeScore + awayScore;
  let pHome = homeScore / total;
  let pAway = awayScore / total;

  // Дял за равенство според близостта на силите
  const closeness = 1 - Math.abs(pHome - pAway); // 1 = равностойни
  const pDraw = 0.18 + closeness * 0.14; // 18-32%

  // Нормализираме трите да дават 100%
  const scale = (1 - pDraw);
  pHome = pHome * scale;
  pAway = pAway * scale;

  const homePct = Math.round(pHome * 100);
  const awayPct = Math.round(pAway * 100);
  const drawPct = 100 - homePct - awayPct;

  // Очаквани голове
  const expHomeGoals = (home.avgScored + away.avgConceded) / 2;
  const expAwayGoals = (away.avgScored + home.avgConceded) / 2;
  const expTotal = expHomeGoals + expAwayGoals;

  // Препоръка
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

      // 3) Смятаме прогнозата
      const prediction = computePrediction(
        Object.assign({ name: homeTeam.name }, homeForm),
        Object.assign({ name: awayTeam.name }, awayForm),
        h2h
      );

      const result = {
        home: { id: homeTeam.id, name: homeTeam.name, logo: homeTeam.logo, country: homeTeam.country, form: homeForm },
        away: { id: awayTeam.id, name: awayTeam.name, logo: awayTeam.logo, country: awayTeam.country, form: awayForm },
        h2h: h2h,
        prediction: prediction
      };
      setCached(cacheKey, result);
      return sendJSON(res, 200, result);
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
