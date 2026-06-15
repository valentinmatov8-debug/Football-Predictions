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

// ============================================================
//   API заявки - брояч (макс 5000/ден за AI, 2500 за сайта)
// ============================================================
const apiUsage = { date: '', count: 0, aiCount: 0 };
const API_DAILY_LIMIT = 7000;      // общ лимит (пазим 500 резерв)
const AI_DAILY_LIMIT = 5000;       // за AI обучение
const SITE_DAILY_LIMIT = 2000;     // за сайта

function getTodayStr() { return new Date().toISOString().slice(0, 10); }

function checkApiUsage(isAI = false) {
  const today = getTodayStr();
  if (apiUsage.date !== today) { apiUsage.date = today; apiUsage.count = 0; apiUsage.aiCount = 0; }
  if (apiUsage.count >= API_DAILY_LIMIT) return false;
  if (isAI && apiUsage.aiCount >= AI_DAILY_LIMIT) return false;
  return true;
}

function trackApiUsage(isAI = false) {
  apiUsage.count++;
  if (isAI) apiUsage.aiCount++;
}

async function apiFetchTracked(endpoint, isAI = false) {
  if (!checkApiUsage(isAI)) throw new Error('API_LIMIT_REACHED');
  trackApiUsage(isAI);
  const res = await fetch(API_BASE + endpoint, { headers: { 'x-apisports-key': API_KEY } });
  if (!res.ok) throw new Error('API ' + res.status);
  return res.json();
}

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
        injury_weight REAL DEFAULT 1.0,
        fatigue_weight REAL DEFAULT 1.0,
        odds_weight REAL DEFAULT 1.0,
        total_checked INTEGER DEFAULT 0,
        total_correct INTEGER DEFAULT 0,
        last_updated TIMESTAMP DEFAULT NOW()
      );
    `);
    // Исторически тренировъчни данни за AI (събирани автоматично)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS training_data (
        id SERIAL PRIMARY KEY,
        fixture_id BIGINT UNIQUE,
        home_team TEXT,
        away_team TEXT,
        league TEXT,
        season INTEGER,
        home_goals INTEGER,
        away_goals INTEGER,
        result TEXT,
        home_form_pts REAL,
        away_form_pts REAL,
        home_avg_scored REAL,
        home_avg_conceded REAL,
        away_avg_scored REAL,
        away_avg_conceded REAL,
        h2h_home_wins INTEGER,
        h2h_away_wins INTEGER,
        h2h_draws INTEGER,
        match_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // Дневен API брояч (за dashboard)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_usage_log (
        log_date DATE PRIMARY KEY,
        total_calls INTEGER DEFAULT 0,
        ai_calls INTEGER DEFAULT 0,
        site_calls INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // вкарваме начален ред за тежестите, ако липсва
    await pool.query(`INSERT INTO ai_weights (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);
    // Добавяме нови колони ако липсват (миграция)
    await pool.query(`ALTER TABLE ai_weights ADD COLUMN IF NOT EXISTS injury_weight REAL DEFAULT 1.0`);
    await pool.query(`ALTER TABLE ai_weights ADD COLUMN IF NOT EXISTS fatigue_weight REAL DEFAULT 1.0`);
    await pool.query(`ALTER TABLE ai_weights ADD COLUMN IF NOT EXISTS odds_weight REAL DEFAULT 1.0`);
    await pool.query(`ALTER TABLE ai_weights ADD COLUMN IF NOT EXISTS last_updated TIMESTAMP DEFAULT NOW()`);
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
  trackApiUsage(false);
  const res = await fetch(API_BASE + endpoint, { headers: { 'x-apisports-key': API_KEY } });
  if (!res.ok) throw new Error('API ' + res.status);
  return res.json();
}

// Запазва дневния API usage в БД за dashboard
async function logApiUsage() {
  try {
    const today = getTodayStr();
    await pool.query(`
      INSERT INTO api_usage_log (log_date, total_calls, ai_calls, site_calls, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (log_date) DO UPDATE SET
        total_calls = $2, ai_calls = $3, site_calls = $4, updated_at = NOW()
    `, [today, apiUsage.count, apiUsage.aiCount, apiUsage.count - apiUsage.aiCount]);
  } catch (e) { /* тихо */ }
}
setInterval(logApiUsage, 60000);

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

// Изчислява прогноза от реалните данни - ПОДОБРЕНА ВЕРСИЯ с повече фактори
function computePrediction(home, away, h2h, weights, extra = {}) {
  const w = weights || { form_weight: 1.0, home_advantage: 1.0, goals_weight: 1.0, h2h_weight: 1.0, injury_weight: 1.0, fatigue_weight: 1.0, odds_weight: 1.0 };

  // --- Основни сили ---
  const homeGoalDiff = (home.avgScored - home.avgConceded) * 2 * w.goals_weight;
  const awayGoalDiff = (away.avgScored - away.avgConceded) * 2 * w.goals_weight;

  // --- Умора: ако мачът е бил преди <4 дни → наказание ---
  const homeFatigue = (extra.homeDaysSinceLast != null && extra.homeDaysSinceLast < 4)
    ? -0.4 * w.fatigue_weight : 0;
  const awayFatigue = (extra.awayDaysSinceLast != null && extra.awayDaysSinceLast < 4)
    ? -0.4 * w.fatigue_weight : 0;

  // --- Наранявания: всеки контузен → -0.18 ---
  const homeInjury = (extra.homeInjuries || 0) * 0.18 * w.injury_weight;
  const awayInjury = (extra.awayInjuries || 0) * 0.18 * w.injury_weight;

  // --- Odds сигнал: движение на котировките ---
  // положително = домакинът е подсилен от пазара
  const oddsBoost = (extra.oddsSignal || 0) * w.odds_weight;

  // --- Форма (последни мачове) с тегло 10 вместо 5 ---
  const homeLongForm = extra.homeLongForm || null;
  const awayLongForm = extra.awayLongForm || null;
  const homeFormBonus = homeLongForm ? (homeLongForm.wins * 3 + homeLongForm.draws) * 0.05 : 0;
  const awayFormBonus = awayLongForm ? (awayLongForm.wins * 3 + awayLongForm.draws) * 0.05 : 0;

  const homeStrength = Math.max(0.1,
    home.points * w.form_weight +
    homeGoalDiff +
    1.2 * w.home_advantage +
    homeFatigue - homeInjury + oddsBoost + homeFormBonus
  );
  const awayStrength = Math.max(0.1,
    away.points * w.form_weight +
    awayGoalDiff +
    awayFatigue - awayInjury - oddsBoost + awayFormBonus
  );

  // --- H2H ---
  let homeH2H = 0, awayH2H = 0;
  if (h2h && h2h.total > 0) {
    homeH2H = h2h.team1Wins * 0.8 * w.h2h_weight;
    awayH2H = h2h.team2Wins * 0.8 * w.h2h_weight;
  }

  const homeScore = Math.max(0.1, homeStrength + homeH2H);
  const awayScore = Math.max(0.1, awayStrength + awayH2H);

  const total = homeScore + awayScore;
  let pHome = homeScore / total;
  let pAway = awayScore / total;

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

  // Сигурност: колко фактора подкрепят прогнозата
  let factorsAligned = 0;
  if (homeStrength > awayStrength && pickType === '1') factorsAligned++;
  if (h2h && h2h.team1Wins > h2h.team2Wins && pickType === '1') factorsAligned++;
  if (h2h && h2h.team2Wins > h2h.team1Wins && pickType === '2') factorsAligned++;
  if (oddsBoost > 0 && pickType === '1') factorsAligned++;
  if (oddsBoost < 0 && pickType === '2') factorsAligned++;
  if ((extra.homeInjuries || 0) < (extra.awayInjuries || 0) && pickType === '1') factorsAligned++;

  return {
    homePct, drawPct, awayPct,
    pick, pickType,
    expHomeGoals: Math.round(expHomeGoals * 10) / 10,
    expAwayGoals: Math.round(expAwayGoals * 10) / 10,
    expTotalGoals: Math.round(expTotal * 10) / 10,
    over25, bttsLikely,
    confidence: Math.max(homePct, drawPct, awayPct),
    factorsAligned,
    extra: {
      homeFatigue: homeFatigue !== 0,
      awayFatigue: awayFatigue !== 0,
      homeInjuries: extra.homeInjuries || 0,
      awayInjuries: extra.awayInjuries || 0,
      oddsSignal: extra.oddsSignal || 0
    }
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

// Проверява свършилите мачове и учи от тях - УМНО САМООБУЧЕНИЕ
let lastLearnTime = 0;
async function checkAndLearn() {
  if (Date.now() - lastLearnTime < 600000) return;
  lastLearnTime = Date.now();
  try {
    const pending = await pool.query(
      `SELECT * FROM predictions WHERE checked = false AND match_date < NOW() - INTERVAL '2 hours' LIMIT 20`
    );
    if (pending.rows.length === 0) return;

    let correctDelta = 0, checkedDelta = 0;
    let formErrors = 0, h2hErrors = 0, homeAdvErrors = 0;

    for (const p of pending.rows) {
      let fx;
      try {
        const data = await apiFetch('/fixtures?id=' + p.fixture_id);
        fx = (data.response || [])[0];
      } catch (e) { continue; }
      if (!fx) continue;
      const status = fx.fixture.status.short;
      if (!['FT','AET','PEN'].includes(status)) continue;

      const gh = fx.goals.home, ga = fx.goals.away;
      let actualResult = 'X';
      if (gh > ga) actualResult = '1';
      else if (ga > gh) actualResult = '2';
      const correct = (p.predicted === actualResult);

      await pool.query(
        `UPDATE predictions SET actual_home=$1, actual_away=$2, actual_result=$3, correct=$4, checked=true WHERE fixture_id=$5`,
        [gh, ga, actualResult, correct, p.fixture_id]
      );

      // Запази в training_data за бъдещо обучение
      try {
        await pool.query(`
          INSERT INTO training_data (fixture_id, home_team, away_team, league, result,
            home_goals, away_goals, match_date)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (fixture_id) DO NOTHING
        `, [p.fixture_id, p.home_team, p.away_team, p.league, actualResult, gh, ga, p.match_date]);
      } catch(e) {}

      checkedDelta++;
      if (correct) correctDelta++;
      else {
        // Анализирай вида грешка
        if (p.predicted === '1' && actualResult === '2') homeAdvErrors++;
        if (Math.abs(p.prob_home - p.prob_away) < 15) h2hErrors++;
        formErrors++;
      }
    }

    if (checkedDelta > 0) {
      await pool.query(
        `UPDATE ai_weights SET total_checked = total_checked + $1, total_correct = total_correct + $2, last_updated = NOW() WHERE id = 1`,
        [checkedDelta, correctDelta]
      );

      // УМНО самообучение - коригира конкретните слаби места
      const wq = await pool.query('SELECT * FROM ai_weights WHERE id = 1');
      const w = wq.rows[0];
      if (w && w.total_checked >= 10) {
        const accuracy = w.total_correct / w.total_checked;

        if (homeAdvErrors > checkedDelta * 0.4) {
          // Прекалено разчитаме на домакинско предимство
          await pool.query(`UPDATE ai_weights SET home_advantage = GREATEST(home_advantage - 0.05, 0.5) WHERE id = 1`);
        }
        if (h2hErrors > checkedDelta * 0.4) {
          // H2H не помага много → намали теглото му
          await pool.query(`UPDATE ai_weights SET h2h_weight = GREATEST(h2h_weight - 0.03, 0.3) WHERE id = 1`);
        }
        if (accuracy < 0.55) {
          // Ниска точност → засили формата
          await pool.query(`UPDATE ai_weights SET form_weight = LEAST(form_weight + 0.04, 2.0), goals_weight = LEAST(goals_weight + 0.03, 2.0) WHERE id = 1`);
        } else if (accuracy > 0.72) {
          // Добра точност → стабилизирай
          await pool.query(`UPDATE ai_weights SET form_weight = LEAST(form_weight + 0.01, 2.0) WHERE id = 1`);
        }

        console.log(`🧠 AI научи от ${checkedDelta} мача | Точност: ${(accuracy*100).toFixed(1)}%`);
      }
    }
  } catch (e) { console.error('checkAndLearn грешка:', e.message); }
}

// ============================================================
//   АВТОМАТИЧЕН КОЛЕКТОР НА ИСТОРИЧЕСКИ ДАННИ (5000 заявки/ден)
// ============================================================
const TOP_LEAGUES = [39, 140, 135, 78, 61, 94, 88, 203, 71, 179];
const SEASONS = [2020, 2021, 2022, 2023, 2024];
let collectorRunning = false;
let collectorState = { league: 0, season: 0, page: 0, totalCollected: 0 };

async function collectHistoricalData() {
  if (collectorRunning) return;
  if (!checkApiUsage(true)) {
    console.log('⏸ AI лимит достигнат днес - ще продължи утре');
    return;
  }

  // Провери дали имаме нужда от повече данни
  const countRes = await pool.query('SELECT COUNT(*) FROM training_data');
  const totalMatches = parseInt(countRes.rows[0].count);
  collectorState.totalCollected = totalMatches;

  if (totalMatches >= 50000) {
    console.log(`✅ Достатъчно данни: ${totalMatches} мача`);
    return;
  }

  collectorRunning = true;
  console.log(`🔄 Събиране на данни... (${totalMatches} мача досега)`);

  try {
    // Вземи следващата партида (пести заявки с кеш)
    for (const leagueId of TOP_LEAGUES) {
      for (const season of SEASONS) {
        if (!checkApiUsage(true)) { collectorRunning = false; return; }

        const cacheKey = `hist:${leagueId}:${season}`;
        const alreadyDone = getCached(cacheKey, 86400000); // 24ч кеш
        if (alreadyDone) continue;

        try {
          const data = await apiFetchTracked(`/fixtures?league=${leagueId}&season=${season}&status=FT`, true);
          const fixtures = data.response || [];

          let newCount = 0;
          for (const f of fixtures) {
            const gh = f.goals.home, ga = f.goals.away;
            if (gh == null || ga == null) continue;
            let result = 'X';
            if (gh > ga) result = '1';
            else if (ga > gh) result = '2';

            try {
              const r = await pool.query(`
                INSERT INTO training_data (fixture_id, home_team, away_team, league, season,
                  home_goals, away_goals, result, match_date)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                ON CONFLICT (fixture_id) DO NOTHING
              `, [f.fixture.id, f.teams.home.name, f.teams.away.name,
                  f.league.name, season, gh, ga, result, f.fixture.date]);
              if (r.rowCount > 0) newCount++;
            } catch(e) {}
          }

          if (newCount > 0) {
            collectorState.totalCollected += newCount;
            console.log(`📥 Лига ${leagueId} / ${season}: +${newCount} мача (общо: ${collectorState.totalCollected})`);
          }
          setCached(cacheKey, true);

          // Малка пауза между заявките
          await new Promise(r => setTimeout(r, 200));

        } catch(e) {
          if (e.message === 'API_LIMIT_REACHED') { collectorRunning = false; return; }
        }
      }
    }
  } finally {
    collectorRunning = false;
  }
}

// Стартира колектора на всеки час (в рамките на AI лимита)
setInterval(async () => {
  try { await collectHistoricalData(); } catch(e) {}
}, 3600000);

// И веднъж при старт (след 30 сек)
setTimeout(async () => {
  try { await collectHistoricalData(); } catch(e) {}
}, 30000);

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

    // Временен admin endpoint за нулиране на парола
    if (route === '/api/admin-reset' && method === 'POST') {
      const body = await readBody(req);
      const secret = body.secret || '';
      const email = (body.email || '').trim().toLowerCase();
      const newPass = body.password || '';
      if (secret !== 'goalmind-admin-2024') return sendJSON(res, 403, { error: 'forbidden' });
      if (!email || newPass.length < 6) return sendJSON(res, 400, { error: 'invalid' });
      const hash = await bcrypt.hash(newPass, 10);
      await pool.query('UPDATE users SET password_hash=$1, is_pro=true WHERE email=$2', [hash, email]);
      return sendJSON(res, 200, { ok: true, message: 'Password updated and PRO activated' });
    }

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
      const fixtureId = body.fixtureId || null;
      if (!homeName || !awayName) return sendJSON(res, 400, { error: 'missing_teams' });

      const cacheKey = 'predict:' + homeName.toLowerCase() + ':' + awayName.toLowerCase();
      const cached = getCached(cacheKey, 600000);
      if (cached) return sendJSON(res, 200, cached);

      const homeTeam = await findTeam(homeName);
      if (!homeTeam) return sendJSON(res, 404, { error: 'home_not_found', name: homeName });
      const awayTeam = await findTeam(awayName);
      if (!awayTeam) return sendJSON(res, 404, { error: 'away_not_found', name: awayName });

      // Вземи форма (5 мача) + дълга форма (10 мача) + H2H паралелно
      const [homeForm, awayForm, homeLongForm, awayLongForm, h2h] = await Promise.all([
        getTeamForm(homeTeam.id, 5),
        getTeamForm(awayTeam.id, 5),
        getTeamForm(homeTeam.id, 10),
        getTeamForm(awayTeam.id, 10),
        getH2H(homeTeam.id, awayTeam.id, 10)
      ]);

      // Наранявания (ако имаме fixture ID)
      let homeInjuries = 0, awayInjuries = 0;
      if (fixtureId) {
        try {
          const injData = await apiFetch('/injuries?fixture=' + fixtureId);
          const players = injData.response || [];
          homeInjuries = players.filter(p => p.team && p.team.id === homeTeam.id).length;
          awayInjuries = players.filter(p => p.team && p.team.id === awayTeam.id).length;
        } catch(e) {}
      }

      // Odds (ако имаме fixture ID)
      let oddsSignal = 0;
      if (fixtureId) {
        try {
          const oddsData = await apiFetch('/odds?fixture=' + fixtureId);
          const resp = (oddsData.response || [])[0];
          if (resp && resp.bookmakers && resp.bookmakers[0]) {
            const bm = resp.bookmakers[0];
            const mw = (bm.bets || []).find(b => b.name === 'Match Winner');
            if (mw) {
              const homeOdd = parseFloat((mw.values.find(v => v.value === 'Home') || {}).odd) || 0;
              const awayOdd = parseFloat((mw.values.find(v => v.value === 'Away') || {}).odd) || 0;
              if (homeOdd && awayOdd) {
                // По-ниска котировка = по-вероятен → сигнал
                oddsSignal = (1/homeOdd - 1/awayOdd);
              }
            }
          }
        } catch(e) {}
      }

      // Умора: дни от последния мач
      const homeDaysSinceLast = homeForm.recent[0]
        ? Math.floor((Date.now() - new Date(homeForm.recent[0].date)) / 86400000) : 7;
      const awayDaysSinceLast = awayForm.recent[0]
        ? Math.floor((Date.now() - new Date(awayForm.recent[0].date)) / 86400000) : 7;

      const weights = await getWeights();
      const prediction = computePrediction(
        Object.assign({ name: homeTeam.name }, homeForm),
        Object.assign({ name: awayTeam.name }, awayForm),
        h2h, weights,
        { homeInjuries, awayInjuries, oddsSignal, homeDaysSinceLast, awayDaysSinceLast, homeLongForm, awayLongForm }
      );

      const result = {
        home: { id: homeTeam.id, name: homeTeam.name, logo: homeTeam.logo, country: homeTeam.country, form: homeForm, longForm: homeLongForm },
        away: { id: awayTeam.id, name: awayTeam.name, logo: awayTeam.logo, country: awayTeam.country, form: awayForm, longForm: awayLongForm },
        h2h, prediction,
        meta: { homeInjuries, awayInjuries, oddsSignal: oddsSignal.toFixed(3), homeDaysSinceLast, awayDaysSinceLast }
      };
      setCached(cacheKey, result);
      if (fixtureId) savePrediction(fixtureId, homeTeam.name, awayTeam.name, '', null, prediction);
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

    // ---------- СИГУРНИ ЗАЛОЗИ - С ЖИВИ МАЧОВЕ ----------
    if (route === '/api/sure-bets') {
      if (!API_KEY) return sendJSON(res, 500, { error: 'no_key' });

      try {
        const weights = await getWeights();

        // Живите мачове - кеш 60 сек (актуални)
        // Днешните мачове - кеш 5 мин (не се менят често)
        const [liveData, todayData] = await Promise.all([
          (getCached('sb-live', 60000) ? Promise.resolve({ response: getCached('sb-live', 60000) }) :
            apiFetch('/fixtures?live=all').then(d => { setCached('sb-live', d.response || []); return d; })).catch(() => ({ response: [] })),
          (getCached('sb-today', 300000) ? Promise.resolve({ response: getCached('sb-today', 300000) }) :
            apiFetch('/fixtures?date=' + new Date().toISOString().slice(0,10)).then(d => { setCached('sb-today', d.response || []); return d; })).catch(() => ({ response: [] }))
        ]);

        // Живите мачове ВИНАГИ първи
        const seen = {};
        let fixtures = [...(liveData.response || []), ...(todayData.response || [])].filter(f => {
          if (seen[f.fixture.id]) return false;
          seen[f.fixture.id] = 1;
          return true;
        });
        fixtures = fixtures.slice(0, 35);

        const sureBets = [];
        for (const f of fixtures) {
          const status = f.fixture.status.short;
          if (['FT','AET','PEN','PST','CANC'].includes(status)) continue;
          const isLive = ['1H','HT','2H','ET','BT','P','LIVE'].includes(status);

          try {
            const [hForm, aForm, hLong, aLong, h2h] = await Promise.all([
              getTeamForm(f.teams.home.id, 5),
              getTeamForm(f.teams.away.id, 5),
              getTeamForm(f.teams.home.id, 10),
              getTeamForm(f.teams.away.id, 10),
              getH2H(f.teams.home.id, f.teams.away.id, 10)
            ]);
            const homeDays = hForm.recent[0] ? Math.floor((Date.now() - new Date(hForm.recent[0].date)) / 86400000) : 7;
            const awayDays = aForm.recent[0] ? Math.floor((Date.now() - new Date(aForm.recent[0].date)) / 86400000) : 7;

            const pred = computePrediction(
              Object.assign({ name: f.teams.home.name }, hForm),
              Object.assign({ name: f.teams.away.name }, aForm),
              h2h, weights,
              { homeLongForm: hLong, awayLongForm: aLong, homeDaysSinceLast: homeDays, awayDaysSinceLast: awayDays }
            );

            // Живите мачове с по-нисък праг (60%) за да се показват
            const threshold = isLive ? 58 : 60;
            const isSure = pred.confidence >= threshold && hForm.played >= 3 && aForm.played >= 3;

            if (isSure) {
              let sureLevel = 'low';
              if (pred.confidence >= 72 && pred.factorsAligned >= 3) sureLevel = 'high';
              else if (pred.confidence >= 65) sureLevel = 'medium';

              sureBets.push({
                fixtureId: f.fixture.id,
                league: f.league.name, flag: f.league.flag,
                home: f.teams.home.name, away: f.teams.away.name,
                homeLogo: f.teams.home.logo, awayLogo: f.teams.away.logo,
                date: f.fixture.date, isLive,
                elapsed: f.fixture.status.elapsed,
                pick: pred.pick, pickType: pred.pickType,
                confidence: pred.confidence,
                homePct: pred.homePct, drawPct: pred.drawPct, awayPct: pred.awayPct,
                factorsAligned: pred.factorsAligned, sureLevel, extra: pred.extra
              });
              savePrediction(f.fixture.id, f.teams.home.name, f.teams.away.name, f.league.name, f.fixture.date, pred);
            }
          } catch (e) { continue; }
          if (sureBets.length >= 15) break;
        }

        // Живите мачове ПЪРВИ, после по увереност
        sureBets.sort((a, b) => {
          if (a.isLive && !b.isLive) return -1;
          if (!a.isLive && b.isLive) return 1;
          const lo = { high: 3, medium: 2, low: 1 };
          if (lo[b.sureLevel] !== lo[a.sureLevel]) return lo[b.sureLevel] - lo[a.sureLevel];
          return b.confidence - a.confidence;
        });

        const result = { count: sureBets.length, bets: sureBets };
        checkAndLearn();
        return sendJSON(res, 200, result);
      } catch (e) {
        return sendJSON(res, 200, { count: 0, bets: [] });
      }
    }

    // ---------- AI LEARNING DASHBOARD ----------
    if (route === '/api/ai-dashboard') {
      try {
        const [weights, trainingCount, predictions] = await Promise.all([
          pool.query('SELECT * FROM ai_weights WHERE id = 1'),
          pool.query('SELECT COUNT(*) FROM training_data'),
          pool.query(`
            SELECT
              COUNT(*) FILTER (WHERE checked = true) AS checked,
              COUNT(*) FILTER (WHERE correct = true) AS correct,
              COUNT(*) FILTER (WHERE checked = true AND created_at > NOW() - INTERVAL '7 days') AS week_checked,
              COUNT(*) FILTER (WHERE correct = true AND created_at > NOW() - INTERVAL '7 days') AS week_correct,
              COUNT(*) FILTER (WHERE checked = true AND created_at > NOW() - INTERVAL '24 hours') AS today_checked,
              COUNT(*) FILTER (WHERE correct = true AND created_at > NOW() - INTERVAL '24 hours') AS today_correct
            FROM predictions
          `)
        ]);

        const w = weights.rows[0] || {};
        const p = predictions.rows[0] || {};
        const totalMatches = parseInt(trainingCount.rows[0].count) || 0;
        const totalChecked = parseInt(p.checked) || 0;
        const totalCorrect = parseInt(p.correct) || 0;
        const accuracy = totalChecked > 0 ? Math.round((totalCorrect / totalChecked) * 1000) / 10 : 0;

        const recentRows = await pool.query(
          `SELECT correct FROM predictions WHERE checked = true ORDER BY match_date DESC LIMIT 20`
        );
        let streak = 0;
        for (const row of recentRows.rows) { if (row.correct) streak++; else break; }

        const targetMatches = totalMatches < 1000 ? 1000 : totalMatches < 5000 ? 5000 : totalMatches < 20000 ? 20000 : 50000;
        const progress = Math.min(100, Math.round((totalMatches / targetMatches) * 100));

        return sendJSON(res, 200, {
          training: {
            totalMatches, targetMatches, progress,
            level: totalMatches < 500 ? 'Начинаещ' : totalMatches < 5000 ? 'Учи се' : totalMatches < 20000 ? 'Напреднал' : 'Експерт',
            collectorActive: collectorRunning
          },
          predictions: {
            totalChecked, totalCorrect, accuracy,
            weekChecked: parseInt(p.week_checked) || 0,
            weekCorrect: parseInt(p.week_correct) || 0,
            weekAccuracy: parseInt(p.week_checked) > 0 ? Math.round((parseInt(p.week_correct) / parseInt(p.week_checked)) * 1000) / 10 : 0,
            todayChecked: parseInt(p.today_checked) || 0,
            todayCorrect: parseInt(p.today_correct) || 0,
            streak
          },
          weights: {
            form: Math.round((w.form_weight || 1) * 100) / 100,
            homeAdvantage: Math.round((w.home_advantage || 1) * 100) / 100,
            goals: Math.round((w.goals_weight || 1) * 100) / 100,
            h2h: Math.round((w.h2h_weight || 1) * 100) / 100,
            injury: Math.round((w.injury_weight || 1) * 100) / 100,
            fatigue: Math.round((w.fatigue_weight || 1) * 100) / 100,
            odds: Math.round((w.odds_weight || 1) * 100) / 100,
            lastUpdated: w.last_updated
          },
          apiUsage: {
            today: apiUsage.count,
            aiToday: apiUsage.aiCount,
            siteToday: apiUsage.count - apiUsage.aiCount,
            limit: 7500,
            aiLimit: AI_DAILY_LIMIT,
            siteLimit: SITE_DAILY_LIMIT,
            remaining: 7500 - apiUsage.count
          }
        });
      } catch(e) {
        return sendJSON(res, 500, { error: e.message });
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
