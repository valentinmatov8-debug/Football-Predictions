const http = изискване('http');
const fs = изискване('fs');
const път = изискване('път');
const крипто = изискване('крипто');
const { Pool } = require('pg');
const bcrypt = изискване('bcryptjs');

const ПОРТ = process.env.ПОРТ || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = 'https://v3.football.api-sports.io';
const PUBLIC_DIR = път.присъединяване(__dirname, 'public');

// ---------- База данни (PostgreSQL от Render) ----------
const pool = нов Pool({
  connectionString: process.env.URL_НА_БАЗА_ДАННИ,
  ssl: { rejectUnauthorized: false }
});

// Създаваме таблиците при стартиране, ако ги няма
асинхронна функция initDatabase() {
  опитай {
    чакам pool.query(`
      СЪЗДАВАНЕ НА ТАБЛИЦА, АКО НЕ СЪЩЕСТВУВА потребители (
        идентификатор на СЕРИЕН ПЪРВИЧЕН КЛЮЧ,
        имейл ТЕКСТ УНИКАЛЕН НЕ НУЛЕВ,
        потребителско име TEXT,
        ТЕКСТЪТ НА password_hash НЕ Е NULL,
        is_pro БУЛЕВ ПО СТАНДАРТНО НЕВЯРНО,
        created_at ВРЕМЕВ КЛЕМКА ПО ПО СТАНДАРТ СЕГА()
      );
    `);
    чакам pool.query(`
      СЪЗДАВАНЕ НА ТАБЛИЦА, АКО НЕ СЪЩЕСТВУВА сесии (
        ТЕКСТ НА ТОКСОН, ПЪРВИЧЕН КЛЮЧ,
        user_id ЦЕЛОЧИСЛЕНИ ПРЕПОРЪКИ users(id) ПРИ ИЗТРИВАНЕ КАСКАДНО,
        created_at ВРЕМЕВ КЛЕМКА ПО ПО СТАНДАРТ СЕГА()
      );
    `);
    чакам pool.query(`
      СЪЗДАВАНЕ НА ТАБЛИЦА, АКО НЕ СЪЩЕСТВУВА посещения (
        country_code TEXT ПЪРВИЧЕН КЛЮЧ,
        име_на_държава ТЕКСТ,
        брой ЦЯЛО ЧИСЛО ПО СТАНДАРТНО 0
      );
    `);
    // Прогнози - всяка прогноза, която AI прави (за самообучение и статистика)
    чакам pool.query(`
      СЪЗДАВАНЕ НА ТАБЛИЦА, АКО НЕ СЪЩЕСТВУВА прогнози (
        fixture_id BIGINT ПЪРВИЧЕН КЛЮЧ,
        домашен_отбор ТЕКСТ,
        гостуващ отбор ТЕКСТ,
        лига ТЕКСТ,
        ВРЕМЕНЕН КЛЕЙК НА ДАТА НА СЪБИТИЯ,
        prob_home ЦЯЛО ЧИСЛО,
        prob_draw ЦЯЛО ЧИСЛО,
        prob_away ЦЯЛО ЧИСЛО,
        предвиден TEXT,
        доверие ЦЯЛО ЧИСЛО,
        действителен_дом ЦЯЛО ЧИСЛО,
        действително_далеч ЦЯЛО ЧИСЛО,
        действителен_резултат ТЕКСТ,
        правилен БУЛЕВ,
        проверено БУЛЕВО ПО ПО ПО ПОРАДИ НЕВЯРНО,
        created_at ВРЕМЕВ КЛЕМКА ПО ПО СТАНДАРТ СЕГА()
      );
    `);
    // Тежести за самообучението (как AI претегля факторите)
    чакам pool.query(`
      СЪЗДАВАНЕ НА ТАБЛИЦА, АКО НЕ СЪЩЕСТВУВА ai_weights (
        id ЦЯЛО ЧИСЛО ПЪРВИЧЕН КЛЮЧ ПО СТАНДАРТНО 1,
        форма_тегло РЕАЛНА СТОЙНОСТ ПО СТАНДАРТ 1.0,
        home_advantage РЕАЛНА ВЕРСИЯ ПО СТАНДАРТНО ПОСТАВЯНЕ 1.0,
        тегло_на_целите РЕАЛНА СТОЙНОСТ ПО СТАНДАРТ 1.0,
        h2h_weight РЕАЛНА СТОЙНОСТ ПО СТАНДАРТ 1.0,
        total_checked ЦЯЛО ЧИСЛО ПО СТАНДАРТНО 0,
        total_correct ЦЯЛО ЧИСЛО ПО СТАНДАРТНО 0
      );
    `);
    // вкарваме начален ред за тежестите, ако липсва
    изчакайте pool.query(`INSERT INTO ai_weights (id) VALUES (1) ON CONFLICT (id) НЕ ПРАВЯ НИЩО;`);
    console.log('✓ Базата данни е готова');
  } улов (грешка) {
    console.error('Грешка при създаване на таблиците:', err.message);
  }
}

// ---------- Кеш за API ----------
константен кеш = {};
функция getCached(ключ, maxAgeMs) {
  const e = кеш[ключ];
  ако (e && (Дата.сега() - e.време) < maxAgeMs) върне e.данни;
  връщане на нула;
}
функция setCached(ключ, данни) { кеш[ключ] = { данни, време: Дата.сега() }; }

асинхронна функция apiFetch(крайна точка) {
  const res = изчакване на fetch(API_BASE + крайна точка, { заглавки: { 'x-apisports-key': API_KEY } });
  ако (!res.ok) throw new Error('API ' + res.status);
  върне res.json();
}

функция simplyFixture(f) {
  const статус = f.fixture.status.short;
  const isLive = ['1H','HT','2H','ET','BT','P','LIVE'].includes(статус);
  const isFinished = ['FT','AET','PEN'].includes(статус);
  връщане {
    идентификатор: f.fixture.id, лига: f.league.name, leagueId: f.league.id, флаг: f.league.flag,
    дата: f.fixture.date, статус: status, изтекло: f.fixture.status.elapsed,
    еНаЖиво: еНаЖиво, еЗавършено: еЗавършено,
    начална страница: { име: f.teams.home.name, лого: f.teams.home.logo, цели: f.goals.home },
    гостувания: { име: f.teams.away.name, лого: f.teams.away.logo, голове: f.goals.away }
  };
}

// ---------- Засичане на държавата по IP + броене на посещение ----------
асинхронна функция recordVisit(req) {
  опитай {
    // вземаме реалния IP (Render праща X-Forwarded-For)
    const fwd = req.headers['x-forwarded-for'];
    const ip = fwd ? fwd.split(',')[0].trim() : (req.socket.remoteAddress || '');
    if (!ip || ip.startsWith('127.') || ip === '::1') връщане; // локален - пропускаме

    // безплатно засичане на държавата
    const geoRes = изчакване на fetch('https://ipapi.co/' + ip + '/json/');
    ако (!geoRes.ok) върне;
    const geo = изчакване geoRes.json();
    const код = geo.code_country || 'XX';
    const име = geo.име_на_държава || 'Неизвестно';

    //увеличавам брояча за тази държава (UPSERT)
    чакам pool.query(
      `INSERT INTO посещения (код_на_държава, име_на_държава, брой) СТОЙНОСТИ ($1, $2, 1)
       ПРИ КОНФЛИКТ (код_на_държава) ИЗПЪЛНЕТЕ АКТУАЛИЗАЦИЯТА SET count = visits.count + 1, country_name = $2`,
      [код, име]
    );
  } улов (грешка) {
    // тихо - посещенията не са критични
  }
}

// ---------- Помощни за AI прогноза ----------

// Намира отбор по име, връща {id, name, logo} или null
асинхронна функция findTeam(име) {
  const данни = изчакване на apiFetch('/отбори?търсачка=' + encodeURIComponent(име));
  const t = (данни.отговор || [])[0];
  ако (!t) върне null;
  връщане { id: t.team.id, име: t.team.name, лого: t.team.logo, държава: t.team.country, основан: t.team.founded };
}

// Тегли смята последната N мача за отбор и форма
асинхронна функция getTeamForm(teamId, count) {
  константа n = брой || 5;
  const данни = изчакване apiFetch('/figures?team=' + teamId + '&last=' + n);
  const fixtures = data.response || [];
  Нека победи = 0, равенства = 0, загуби = 0, голове за = 0, голове срещу = 0;
  const formStr = [];
  const скорошни = [];

  fixtures.forEach(f => {
    const isHome = f.teams.home.id === teamId;
    const gf = isHome ? f.goals.home : f.goals.away;
    const ga = isHome ? f.goals.away : f.goals.home;
    ако (gf == null || ga == null) връщане;
    целиЗа += без грохо; целиСрещу += га;
    нека резултатът;
    ако (gf > ga) { wins++; резултат = 'W'; }
    иначе ако (gf < ga) { загуби++; резултат = 'L'; }
    иначе { draws++; резултат = 'D'; }
    formStr.push(резултат);
    const opp = isHome ? f.teams.away : f.teams.home;
    recent.push({
      опонент: име.на.опонент, еДом: еДом,
      резултат: gf + '-' + ga, резултат: result, дата: f.fixture.date
    });
  });

  const изиграна = победи + равенства + загуби;
  връщане {
    играни, победи, равенства, загуби, головеЗа, головеСрещу,
    форма: formStr.join(''),
    Средно отбелязани голове: изиграни ? (голове за / изиграни) : 0,
    средно допуснати голове: изиграни ? (допуснати голове / изиграни): 0,
    // точки от форма: победа=3, равен=1
    точки: победи * 3 + равенства,
    скорошно: скорошно
  };
}

// Директни срещи между два отбора
асинхронна функция getH2H(id1, id2, брой) {
  константа n = брой || 5;
  const данни = изчакване на apiFetch('/fixtures/headtohead?h2h=' + id1 + '-' + id2 + '&last=' + n);
  const fixtures = data.response || [];
  нека отбор1Победи = 0, отбор2Победи = 0, равенства = 0;
  константни съвпадения = [];
  fixtures.forEach(f => {
    const h = f.goals.home, a = f.goals.homes;
    ако (h == null || a == null) връщане;
    const homeId = f.teams.home.id;
    нека winnerId = null;
    ако (h > a) winnerId = homeId;
    иначе ако (a > h) winnerId = f.teams.away.id;
    ако (ИдентификаторНаПобедител === id1) отбор1Победи++;
    иначе ако (ИдентификаторНаПобедител === id2) отбор2Победи++;
    иначе рисува++;
    съвпадения.push({
      домакин: f.teams.home.name, гост: f.teams.away.name,
      резултат: h + '-' + a, дата: f.fixture.date
    });
  });
  връщане { общо: мачове.дължина, отбор1Победи, отбор2Победи, равенства, мачове };
}

// Изчислява прогноза от реалните данни (безплатна формула, с тежести за самообучение)
функция computePrediction(домакин, гост, h2h, тежести) {
  // тежести по подразбиране (ако няма обучени)
  const w = тегла || { форма_тегло: 1.0, домашно_предимство: 1.0, цели_тегло: 1.0, h2h_тегло: 1.0 };

  // Силов рейтинг: форма (точки) + разлика в главата * тегло, с домакинско предимство * тегло
  const РазликаПоГолове = (средноВкараниГолове - средноДопуснатиГолове) * 2 * w.тегло_на_головете;
  const РазликаВГоловетеГост = (СредноВкараниГоловеГост - СредноДопуснатиГоловеГост) * 2 * w.тегло_на_головете;
  const homeStrength = home.points * w.form_weight + homeGoalDiff + 1.2 * w.home_advantage;
  const awayStrength = away.points * w.form_weight + awayGoalDiff;

  // H2H бонус * тегло
  нека homeH2H = 0, awayH2H = 0;
  ако (h2h && h2h.total > 0) {
    homeH2H = h2h.team1Wins * 0.8 * w.h2h_weight;
    гостH2H = h2h.team2Wins * 0.8 * w.h2h_weight;
  }

  const homeScore = Math.max(0.1, homeStrength + homeH2H);
  const awayScore = Math.max(0.1, awayStrength + awayH2H);

  // Базови вероятности
  const общо = домашенРезултат + гостуващРезултат;
  нека pHome = homeScore / total;
  нека pAway = awayScore / total;

  // Дял за равенство спрямо близостта на силите
  const близост = 1 - Math.abs(pHome - pAway);
  const pDraw = 0.18 + близост * 0.14;

  константна скала = (1 - pDraw);
  pHoom = pHoom * мащаб;
  pAway = pAway * мащаб;

  const homePct = Math.round(pHome * 100);
  const awayPct = Math.round(pAway * 100);
  const drawPct = 100 - homePct - awayPct;

  const expДомашниГолове = (домакин.средноВкараниГолове + гост.средноДопуснатиГолове) / 2;
  const expAwayGoals = (гост.средноВкараниГолове + домакин.средноДопуснатиГолове) / 2;
  const expTotal = expHomeGoals + expAwayGoals;

  нека избирам, pickType;
  ако (homePct > awayPct && homePct > drawPct) { pick = home.name; pickType = '1'; }
  иначе ако (awayPct > homePct && awayPct > drawPct) { pick = away.name; pickType = '2'; }
  иначе { pick = 'X'; pickType = 'X'; }

  конст над 25 = expTotal > 2.5;
  const bttsLikely = expHomeGoals > 0.9 && expAwayGoals > 0.9;

  връщане {
    домашенPct, drawPct, awayPct,
    избор, изборТип,
    expHomeGoals: Math.round(expHomeGoals * 10) / 10,
    expAwayGoals: Math.round(expAwayGoals * 10) / 10,
    expTotalGoals: Math.round(expTotal * 10) / 10,
    над 25, вероятно
    увереност: Math.max(homePct, drawPct, awayPct)
  };
}

// Четете тежестта на AI от базата
асинхронна функция getWeights() {
  опитай {
    const r = await pool.query('SELECT * FROM ai_weights WHERE id = 1');
    връщане на r.rows[0] || null;
  } catch (e) { връщане на null; }
}

// Записва прогноза в базата (за самообучение и статистика)
асинхронна функция savePrediction(figureId, homeTeam, awayTeam, league, matchDate, pred) {
  опитай {
    чакам pool.query(
      `INSERT INTO прогнози (match_id, home_team, away_team, league, match_date, prob_home, prob_draw, prob_away, predicted, confidence)`
       СТОЙНОСТИ ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ПРИ КОНФЛИКТ (fixture_id) НЕ ПРАВЕТЕ НИЩО
      [ИДнаМач, домакинскиОтбор, гостуващОтбор, лига, ДатаНаМач, предх.домашенОтбор, предх.равенОтбор, предх.гостуващОтбор, ТипНаМечта, предх.доверие]
    );
  } catch (e) { /* тихо */ }
}

// Проверява свършилите мачове и учи от тях (самообучение)
нека lastLearnTime = 0;
асинхронна функция checkAndLearn() {
  // не по-често от веднъж на 10 мин
  ако (Date.now() - lastLearnTime < 600000) върне;
  lastLearnTime = Date.now();
  опитай {
    // вземаме непроверени прогнози за мачове, които вече трябва да са свършили
    const pending = await pool.query(
      `SELECT * FROM predictions WHERE checked = false AND match_date < NOW() - INTERVAL '2 часа' LIMIT 20`
    );
    ако (pending.rows.length === 0) връщане;

    нека correctDelta = 0, checkedDelta = 0;
    за (const p от pending.rows) {
      // питаме API за резултата
      нека fx;
      опитай {
        const данни = изчакване на apiFetch('/fixtures?id=' + p.fixture_id);
        fx = (данни.отговор || [])[0];
      } catch (e) { продължи; }
      ако (!fx) продължи;
      const статус = fx.fixture.status.short;
      if (!['FT','AET','PEN'].includes(status)) продължи; // още не е свършил

      const gh = fx.goals.home, ga = fx.goals.away;
      нека действителенРезултат = 'X';
      ако (gh > ga) действителенРезултат = '1';
      иначе ако (ga > gh) действителенРезултат = '2';
      const correct = (p.predicted === actualResult);

      чакам pool.query(
        `АКТУАЛИЗИРАНЕ на прогнозите SET actual_home=$1, actual_away=$2, actual_result=$3, correct=$4, checked=true WHERE fixture_id=$5`,
        [gh, ga, actualResult, correct, p.fixture_id]
      );
      провереноDelta++;
      ако (правилно) правилноDelta++;
    }

    ако (проверенДелта > 0) {
      // обновяваме общата статистика
      чакам pool.query(
        `UPDATE ai_weights SET total_checked = total_checked + $1, total_correct = total_correct + $2 WHERE id = 1`,
        [проверенДелта, правиленДелта]
      );
      // самообучение: ако точността е ниска, леко коригираме тежестта
      const wq = await pool.query('SELECT * FROM ai_weights WHERE id = 1');
      const w = wq.rows[0];
      ако (w && w.total_checked >= 20) {
        константна точност = w.total_correct / w.total_checked;
        // ако сме под 50%, засилваме формата (най-важният фактор); ако над 60%, стабилизираме
        ако (точност < 0,5) {
          изчакайте pool.query(`UPDATE ai_weights SET form_weight = LEAST(form_weight + 0.05, 2.0), home_advantage = LEAST(home_advantage + 0.03, 2.0) WHERE id = 1`);
        }
      }
    }
  } catch (e) { /* тихо */ }
}

// ---------- Помощни ----------
функция sendJSON(res, код, obj, заглавки) {
  const h = Object.assign({ 'Тип-съдържание': 'application/json; charset=utf-8' }, заглавки || {});
  res.writeHead(код, h);
  res.end(JSON.stringify(obj));
}

функция readBody(req) {
  върне ново Promise((resolve) => {
    нека тяло = '';
    req.on('данни', chunk => { тяло += chunk; ако (body.length > 1e6) req.destroy(); });
    req.on('край', () => {
      опитайте { resolve(JSON.parse(body || '{}')); }
      улов { разрешаване({}); }
    });
  });
}

функция parseCookies(req) {
  const заглавка = req.headers.cookie || '';
  константа изход = {};
  заглавие.split(';').forEach(p => {
    const i = p.indexOf('=');
    ако (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  връщане навън;
}

функция валиден имейл(e) {
  връщане на тип e === 'низ' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// Връща текущия потребител от сесийна бисквитка (или null)
асинхронна функция getCurrentUser(req) {
  const бисквитки = parseCookies(req);
  const token = cookies.session;
  ако (!токен) върне null;
  опитай {
    const r = изчакване на pool.query(
      `ИЗБЕРЕТЕ потребителско име, потребителски имейл, потребителско име, u.is_pro
       ОТ сесии s ПРИСЪЕДИНЕТЕ се към потребители u ВКЛ. u.id = s.user_id
       КЪДЕТО s.token = $1`, [токен]);
    връщане на r.rows[0] || null;
  } catch { връщане на null; }
}

константа MIME = {
  '.html':'текст/html; charset=utf-8', '.js':'текст/javascript; charset=utf-8',
  '.css':'текст/css; charset=utf-8', '.png':'изображение/png', '.jpg':'изображение/jpeg',
  '.svg':'изображение/svg+xml', '.ico':'изображение/x-икона', '.json':'приложение/json'
};

функция serveStatic(res, filePath) {
  fs.readFile(filePath, (err, данни) => {
    ако (грешка) {
      fs.readFile(path.join(PUBLIC_DIR,'index.html'), (e2, html) => {
        ако (e2) { res.writeHead(404); res.end('Не е намерен'); return; }
        res.writeHead(200, { 'Тип-съдържание':'текст/html; charset=utf-8' });
        res.end(html);
      });
      връщане;
    }
    const ext = път.външноиме(пътКъмфайл).вДолниБащи();
    res.writeHead(200, { 'Тип-съдържание': MIME[въх] || 'приложение/поток-от-октет' });
    res.end(данни);
  });
}


// ==================================================================
// API заявки
// ==================================================================
асинхронна функция handleApi(req, res, маршрут, метод) {
  опитай {
    // ---------- РЕГИСТРАЦИЯ ----------
    ако (маршрут === '/api/register' && метод === 'POST') {
      const тяло = изчакване на readBody(req);
      const имейл = (body.email || '').trim().toLowerCase();
      const парола = тяло.парола || '';
      const потребителско име = (body.потребителско име || '').trim();

      ако (!валиденИмейл(имейл)) върне sendJSON(res, 400, {грешка: 'невалиден_имейл' });
      ако (парола.дължина < 6) върне sendJSON(res, 400, { грешка: 'слаба_парола' });

      // дали проверката на имейла вече съществува
      const exist = await pool.query('SELECT id FROM users WHERE email = $1', [имейл]);
      ако (exist.rows.length > 0) върне sendJSON(res, 409, {грешка: 'email_taken' });

      const hash = await bcrypt.hash(парола, 10);
      const r = изчакване на pool.query(
        'Вмъкнете в потребители (имейл, потребителско име, хеш_на_парола) стойности ($1, $2, $3) Връщайки id, имейл, потребителско_име, is_pro',
        [имейл, потребителско име || null, хеш]);
      const потребител = r.rows[0];

      // създаваме сесия
      const token = crypto.randomBytes(32).toString('hex');
      изчакай pool.query('Вмъкни в сесии (токен, потребителски_идентификатор) стойности ($1, $2)', [токен, потребителски_идентификатор]);

      const cookie = `session=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax; Secure`;
      връщане на sendJSON(res, 200, { потребител: потребител }, { 'Set-Cookie': cookie });
    }

    // ---------- ВХОД ----------
    ако (маршрут === '/api/login' && метод === 'POST') {
      const тяло = изчакване на readBody(req);
      const имейл = (body.email || '').trim().toLowerCase();
      const парола = тяло.парола || '';

      const r = await pool.query('SELECT * FROM users WHERE email = $1', [имейл]);
      const потребител = r.rows[0];
      ако (!потребител) върне sendJSON(res, 401, {грешка: 'невалидни_идентификационни_данни' });

      const ok = изчакай bcrypt.compare(парола, потребител.hash_на_парола);
      ако (!ok) върне sendJSON(res, 401, { грешка: 'invalid_credentials' });

      const token = crypto.randomBytes(32).toString('hex');
      изчакай pool.query('Вмъкни в сесии (токен, потребителски_идентификатор) стойности ($1, $2)', [токен, потребителски_идентификатор]);

      const cookie = `session=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax; Secure`;
      върнете sendJSON(res, 200, {
        потребител: { id: user.id, имейл: user.email, потребителско име: user.username, is_pro: user.is_pro }
      }, { 'Set-Cookie': cookie });
    }

    // ---------- ИЗХОД ----------
    ако (маршрут === '/api/logout' && метод === 'POST') {
      const бисквитки = parseCookies(req);
      ако (бисквитки.сесия) {
        изчакай pool.query('ИЗТРИВАНЕ ОТ сесии, КЪДЕТО token = $1', [cookies.session]);
      }
      const cookie = 'сесия=; Само с Http; Път=/; Максимална възраст=0; SameSite=Lax; Сигурно';
      връщане на sendJSON(res, 200, { ok: true }, { 'Set-Cookie': cookie });
    }

    // ---------- ТЕКУЩ ПОТРЕБИТЕЛ ----------
    ако (маршрут === '/api/me' && метод === 'GET') {
      const потребител = изчакване getCurrentUser(req);
      връщане на sendJSON(res, 200, { потребител: потребител });
    }

    // ---------- БРОЙ PRO ПОТРЕБИТЕЛИ ----------
    ако (маршрут === '/api/stats' && метод === 'GET') {
      const total = await pool.query('SELECT COUNT(*) FROM users');
      const pro = await pool.query('SELECT COUNT(*) FROM users WHERE is_pro = true');
      върнете sendJSON(res, 200, {
        общоПотребители: parseInt(общо.редове[0].брой),
        proUsers: parseInt(pro.rows[0].count)
      });
    }

    // ---------- ФУТБОЛНИ ДАННИ ----------
    ако (маршрут === '/api/здраве') върне sendJSON(res, 200, { ok: true, hasKey: !!API_KEY });

    // Временна администраторска крайна точка за нулиране на парола
    ако (маршрут === '/api/admin-reset' && метод === 'POST') {
      const тяло = изчакване на readBody(req);
      const secret = body.secret || '';
      const имейл = (body.email || '').trim().toLowerCase();
      const newPass = body.password || '';
      ако (тайна !== 'goalmind-admin-2024') върне sendJSON(res, 403, {грешка: 'забранено' });
      ако (!email || newPass.length < 6) върне sendJSON(res, 400, { грешка: 'невалиден' });
      const хеш = изчакай bcrypt.hash(newPass, 10);
      await pool.query('АКТУАЛИЗАЦИЯ на потребителите SET password_hash=$1, is_pro=true WHERE email=$2', [хеш, имейл]);
      връщане на sendJSON(res, 200, { ok: true, съобщение: „Паролата е актуализирана и PRO е активиран“ });
    }

    // Тестов endpoint - мачове от стар сезон (за проверка на безплатния план)
    ако (маршрут === '/api/test') {
      ако (!API_KEY) върне sendJSON(res, 500, {грешка: 'no_key' });
      // Висша лига (league=39), сезон 2021, кръг 1 - достъпно в безплатния план
      const данни = изчакване apiFetch('/матчи?лига=39&сезон=2021&от=13.08.2021&до=16.08.2021');
      const съвпадения = (данни.отговор || []).map(опростяващаПриставка);
      върнете sendJSON(res, 200, {
        инфо: 'Тестови данни от стар сезон 2021',
        суровиРезултати: данни.резултати,
        rawErrors: данни.грешки,
        брой: съвпадения.дължина,
        мачове: мачове
      });
    }

    ако (маршрут === '/api/live') {
      ако (!API_KEY) върне sendJSON(res, 500, {грешка: 'no_key' });
      const c = getCached('live', 20000); ако (c) върне sendJSON(res, 200, c);
      const данни = изчакване apiFetch('/оборудване?на живо=всички');
      const съвпадения = (данни.отговор || []).map(опростяващаПриставка);
      const резултат = { брой: съвпадения.дължина, съвпадения: съвпадения };
      setCached('live', резултат); връщане на sendJSON(res, 200, резултат);
    }
    ако (маршрут === '/api/днес') {
      ако (!API_KEY) върне sendJSON(res, 500, {грешка: 'no_key' });
      const c = getCached('днес', 300000); ако (c) върне sendJSON(res, 200, c);
      const днес = нова Дата().toISOString().slice(0,10);
      const данни = чакам apiFetch('/fixtures?date=' + днес);
      const съвпадения = (данни.отговор || []).map(опростяващаПриставка);
      const резултат = { брой: съвпадения.дължина, съвпадения: съвпадения };
      setCached('днес', резултат); връщане на sendJSON(res, 200, резултат);
    }
    ако (маршрут === '/api/утре') {
      ако (!API_KEY) върне sendJSON(res, 500, {грешка: 'no_key' });
      const c = getCached('утре', 1800000); ако (c) върне sendJSON(res, 200, c);
      const d = нова Дата(); d.setDate(d.getDate()+1);
      const данни = изчакване на apiFetch('/fixtures?date=' + d.toISOString().slice(0,10));
      const съвпадения = (данни.отговор || []).map(опростяващаПриставка);
      const резултат = { брой: съвпадения.дължина, съвпадения: съвпадения };
      setCached('утре', резултат); връщане на sendJSON(res, 200, резултат);
    }

    // ---------- ПОДРОБНОСТИ ЗА МАЧ (събития + статистика) ----------
    ако (маршрут === '/api/съвпадение') {
      ако (!API_KEY) върне sendJSON(res, 500, {грешка: 'no_key' });
      // извличаме id директно от req.url (тук няма променлива url)
      const reqUrl = нов URL(req.url, 'http://' + req.headers.host);
      const id = reqUrl.searchParams.get('id');
      ако (!id) върне sendJSON(res, 400, {грешка: 'missing_id' });

      // кеш 20 сек (живите мачове се менят често)
      const cacheKey = 'съвпадение:' + id;
      const кеширан = getCached(cacheKey, 20000);
      ако (кеширано) върне sendJSON(res, 200, кеширано);

      // основни данни + събития + статистика паралелно
      const [fxData, evData, statData] = изчакване на Promise.all([
        apiFetch('/fixtures?id=' + id).catch(() => ({ отговор: [] })),
        apiFetch('/fixtures/events?fixture=' + id).catch(() => ({ отговор: [] })),
        apiFetch('/fixtures/statistics?fixture=' + id).catch(() => ({ отговор: [] }))
      ]);

      const fx = (fxData.response || [])[0];
      ако (!fx) върне sendJSON(res, 404, { грешка: 'match_not_found' });

      // Събития (голове, картони, смени) - срещу защита на липсващи полета
      const събития = (evData.response || []).map(e => {
        константно време = e.време || {};
        const team = e.team || {};
        връщане {
          минута: време.изминало != null ? време.изминало : null,
          допълнително: време.допълнително != null ? време.допълнително : null,
          тип: e.type || '',
          детайл: e.detail || '',
          екип: име.на.екип || '',
          teamId: team.id || null,
          играч: e.player ? e.player.name : null,
          асистент: e.assist ? e.assist.name : null
        };
      });

      // Статистика по отбор -> правя я лесна за ползване (със защита)
      константни статистики = {};
      (statData.response || []).forEach(teamStat => {
        ако (!teamStat || !teamStat.team) върне;
        const tid = teamStat.team.id;
        статистика[tid] = {};
        (teamStat.статистика || []).forEach(s => {
          ако (s && s.тип != null) статистика[tid][s.тип] = s.стойност;
        });
      });

      // Владение като числа (за сянката)
      const отбори = fx.отбори || {};
      const homeTeam = teams.home || {};
      const awayTeam = teams.away || {};
      const homeId = homeTeam.id;
      const awayId = awayTeam.id;
      const цели = fx.цели || {};
      const fixture = fx.fixture || {};
      const статус = fixture.status || {};
      const лига = fx.лига || {};

      const parsePoss = (v) => {
        ако (v == null) връща null;
        const n = parseInt(String(v).replace('%', ''));
        връщане isNaN(n) ? null : n;
      };
      нека homePoss = stats[homeId] ? parsePoss(stats[homeId]['Притежание на топката']) : null;
      let awayPoss = stats[awayId] ? parsePoss(stats[awayId]['Притежание на топката']) : null;

      константен резултат = {
        идентификатор: fixture.id,
        лига: име.на.лига || '',
        статус: status.short || '',
        изтекло: status.elapsed != null ? status.elapsed : null,
        начало: { id: homeId, име: homeTeam.name || '', лого: homeTeam.logo || '', цели: goals.home != null ? goals.home : 0, владение: homePoss },
        гост: { id: awayId, име: awayTeam.name || '', лого: awayTeam.logo || '', цели: goals.away != null ? goals.away : 0, владение: awayPoss },
        събития: събития,
        статистика: { начало: статистика[homeId] || {}, гост: статистика[awayId] || {} }
      };
      setCached(кешКлюч, резултат);
      връщане на sendJSON(res, 200, резултат);
    }

    // ---------- ЛИГИ С ЖИВИ МАЧОВЕ (за филтъра) ----------
    ако (маршрут === '/api/leagues-live') {
      ако (!API_KEY) върне sendJSON(res, 500, {грешка: 'no_key' });
      const cached = getCached('лиги-на живо', 30000);
      ако (кеширано) върне sendJSON(res, 200, кеширано);
      const данни = изчакване apiFetch('/оборудване?на живо=всички');
      const съвпадения = (данни.отговор || []).map(опростяващаПриставка);
      // групираме по лига
      const КартаНаЛиги = {};
      съвпадения.заВсеки(m => {
        ако (m.leagueId == null) върне;
        ако (!leaguesMap[m.leagueId]) {
          leaguesMap[m.leagueId] = { id: m.leagueId, име: m.league, флаг: m.flag, брой: 0 };
        }
        КартаНаЛиги[m.leagueId].count++;
      });
      const лиги = Object.values(leaguesMap).sort((a, b) => b.count - a.count);
      const резултат = { общо: мачове.дължина, лиги: лиги };
      setCached('лиги-на живо', резултат);
      връщане на sendJSON(res, 200, резултат);
    }

    // ---------- ПОСЕЩЕНИЯ ПО ДЪРЖАВИ + PRO АКАУНТИ ----------
    ако (маршрут === '/api/посещения') {
      опитай {
        const visitsRes = изчакване на pool.query(
          „SELECT код_на_държава, име_на_държава, брой FROM посещения ORDER BY брой DESC LIMIT 12“
        );
        const totalRes = await pool.query('SELECT COALESCE(SUM(брой),0) AS total FROM посещения');
        const proRes = await pool.query('SELECT COUNT(*) AS pro FROM users WHERE is_pro = true');
        върнете sendJSON(res, 200, {
          държави: посещения.редове,
          общо: parseInt(totalRes.rows[0].total) || 0,
          proAccounts: parseInt(proRes.rows[0].pro) || 0
        });
      } улов (грешка) {
        връщане на sendJSON(res, 200, { държави: [], общо: 0, proAccounts: 0 });
      }
    }

    // ---------- ПОДСКАЗВАЧ: търсене на отбори по име ----------
    ако (маршрут === '/api/екип-за-търсене') {
      ако (!API_KEY) върне sendJSON(res, 500, {грешка: 'no_key' });
      const reqUrl = нов URL(req.url, 'http://' + req.headers.host);
      const q = (reqUrl.searchParams.get('q') || '').trim();
      ако (q.length < 3) върне sendJSON(res, 200, { екипи: [] });

      const cacheKey = 'търсене:' + q.toLowerCase();
      const cached = getCached(cacheKey, 3600000); // 1 час
      ако (кеширано) върне sendJSON(res, 200, кеширано);

      опитай {
        const данни = изчакване на apiFetch('/отбори?търсене=' + encodeURIComponent(q));
        const teams = (data.response || []).slice(0, 8).map(t => ({
          име: t.team.name,
          лого: t.team.logo,
          държава: t.team.country
        }));
        const резултат = { отбори: отбори };
        setCached(кешКлюч, резултат);
        връщане на sendJSON(res, 200, резултат);
      } улов (грешка) {
        връщане на sendJSON(res, 200, { екипи: [] });
      }
    }

    // ---------- СТАТИСТИКА ЗА ЕДИН ОТБОР ----------
    ако (маршрут === '/api/team-stats' && метод === 'POST') {
      ако (!API_KEY) върне sendJSON(res, 500, {грешка: 'no_key' });
      const тяло = изчакване на readBody(req);
      const ИмеНаЕкип = (body.ekip || '').trim();
      ако (!teamName) върне sendJSON(res, 400, {грешка: 'no_team' });

      const cacheKey = 'teamstats:' + teamName.toLowerCase();
      const cached = getCached(cacheKey, 600000); // 10 мин
      ако (кеширано) върне sendJSON(res, 200, кеширано);

      // намираме отбора
      const team = изчакване findTeam(имеНаТеам);
      ако (!ekip) върне sendJSON(res, 404, {грешка: 'ekip_not_found' });

      // взимаме формат от последните 10 мача
      const форма = изчакай getTeamForm(team.id, 10);

      константен резултат = {
        екип: { id: team.id, име: team.name, лого: team.logo, държава: team.country, основан: team.founded },
        статистика: {
          свири: форма.свири,
          победи: форма.победи,
          рисува: form.draws,
          загуби: форма.загуби,
          целиЗа: форма.целиЗа,
          целиСрещу: форма.целиСрещу,
          goalDiff: form.goalsFor - form.goalsAgainst,
          среденРезултат: Math.round(form.среденРезултат * 100) / 100,
          средноОтстъпено: Math.round(form.средноОтстъпено * 100) / 100,
          форма: форма.форма,
          точки: форма.точки
        },
        скорошни: form.recent
      };
      setCached(кешКлюч, резултат);
      връщане на sendJSON(res, 200, резултат);
    }

    // ---------- AI ПРОГНОЗА (безплатна формула) ----------
    // ---------- ДИРЕКТНИ СРЕЩИ (H2H) ----------
    ако (маршрут === '/api/h2h' && метод === 'POST') {
      ако (!API_KEY) върне sendJSON(res, 500, {грешка: 'no_key' });
      const тяло = изчакване на readBody(req);
      const homeName = (body.home || '').trim();
      const awayName = (body.away || '').trim();
      ако (!homeName || !awayName) върне sendJSON(res, 400, { грешка: 'missing_teams' });

      const cacheKey = 'h2h:' + homeName.toLowerCase() + ':' + awayName.toLowerCase();
      const кеширан = getCached(кешКейч, 600000);
      ако (кеширано) върне sendJSON(res, 200, кеширано);

      const team1 = изчакване findTeam(началноИме);
      ако (!team1) върне sendJSON(res, 404, { грешка: 'home_not_found', име: homeName });
      const team2 = изчакване findTeam(awayName);
      ако (!team2) върне sendJSON(res, 404, { грешка: 'away_not_found', име: awayName });

      const h2h = изчакване getH2H(team1.id, team2.id, 10);
      константен резултат = {
        отбор1: { id: team1.id, име: team1.name, лого: team1.logo },
        отбор2: { id: team2.id, име: team2.name, лого: team2.logo },
        ч2ч: ч2ч
      };
      setCached(кешКлюч, резултат);
      връщане на sendJSON(res, 200, резултат);
    }

    // ---------- ГОЛОВА СТАТИСТИКА ----------
    ако (маршрут === '/api/цели' && метод === 'POST') {
      ако (!API_KEY) върне sendJSON(res, 500, {грешка: 'no_key' });
      const тяло = изчакване на readBody(req);
      const ИмеНаЕкип = (body.ekip || '').trim();
      ако (!teamName) върне sendJSON(res, 400, {грешка: 'no_team' });

      const cacheKey = 'цели:' + teamName.toLowerCase();
      const кеширан = getCached(кешКейч, 600000);
      ако (кеширано) върне sendJSON(res, 200, кеширано);

      const team = изчакване findTeam(имеНаТеам);
      ако (!ekip) върне sendJSON(res, 404, {грешка: 'ekip_not_found' });

      // последните 10 мача за анализ на главата
      const данни = чакам apiFetch('/fixtures?team=' + team.id + '&last=10');
      const fixtures = data.response || [];
      нека над25 = 0, под25 = 0, btts = 0, cleanSheets = 0, failedToScore = 0;
      нека totalGoals = 0, scoredFirst = 0, counted = 0;

      fixtures.forEach(f => {
        const isHome = f.teams.home.id === team.id;
        const gf = isHome ? f.goals.home : f.goals.away;
        const ga = isHome ? f.goals.away : f.goals.home;
        ако (gf == null || ga == null) връщане;
        преброени++;
        const съвпадениеЦели = gf + ga;
        общоЦели += съвпадениеЦели;
        ако (matchGoals > 2.5) над25++; иначе под25++;
        ако (gf > 0 &ga > 0) btts++;
        ако (ga === 0) cleanSheets++;
        ако (gf === 0) неуспешноОценяване++;
      });

      const pct = (n) => преброени ? Math.round((n / преброени) * 100) : 0;
      константен резултат = {
        отбор: { id: team.id, име: team.name, лого: team.logo, държава: team.country },
        цели: {
          изиграно: преброено,
          avgTotal: преброени ? Math.round((общоГолове / преброени) * 100) / 100 : 0,
          над 25: процент (над 25), под 25: процент (под 25),
          btts: pct(btts), cleanSheets: pct(cleanSheets),
          неуспешноОценяване: pct(неуспешноОценяване)
        }
      };
      setCached(кешКлюч, резултат);
      връщане на sendJSON(res, 200, резултат);
    }

    // ---------- КОЕФИЦИЕНТИ ----------
    ако (маршрут === '/api/коефициенти') {
      ако (!API_KEY) върне sendJSON(res, 500, {грешка: 'no_key' });
      const reqUrl = нов URL(req.url, 'http://' + req.headers.host);
      const fixtureId = reqUrl.searchParams.get('приспособление');
      ако (!fixtureId) върне sendJSON(res, 400, { грешка: 'missing_fixture' });

      const cacheKey = 'коефициенти:' + fixtureId;
      const cached = getCached(cacheKey, 300000); // 5 мин
      ако (кеширано) върне sendJSON(res, 200, кеширано);

      опитай {
        const данни = изчакване на apiFetch('/коефициенти?фикстура=' + фикстураИд);
        const отговор = (данни.отговор || [])[0];
        ако (!resp || !resp.bookmakers || resp.bookmakers.length === 0) {
          връщане на sendJSON(res, 200, { налично: false });
        }
        // вземаме първия букмейкър и пазар "Match Winner"
        const bm = съответно.букмейкъри[0];
        const ПобедителВМача = (bm.bets || []).find(b => b.name === 'Победител в Мача');
        нека коефициентите = null;
        ако (matchWinner) {
          const vals = matchWinner.values ​​|| [];
          коефициенти = {
            начало: (vals.find(v => v.value === 'Начало') || {}).odd || null,
            рисуване: (vals.find(v => v.value === 'Рисуване') || {}).odd || null,
            далеч: (vals.find(v => v.value === 'Далеч') || {}).odd || null
          };
        }
        const резултат = { налично: !!коефициенти, букмейкър: bm.name, коефициенти: коефициенти };
        setCached(кешКлюч, резултат);
        връщане на sendJSON(res, 200, резултат);
      } улов (грешка) {
        връщане на sendJSON(res, 200, { налично: false });
      }
    }

    // ---------- КОНТУЗИИ ----------
    ако (маршрут === '/api/injuries') {
      ако (!API_KEY) върне sendJSON(res, 500, {грешка: 'no_key' });
      const reqUrl = нов URL(req.url, 'http://' + req.headers.host);
      const fixtureId = reqUrl.searchParams.get('приспособление');
      ако (!fixtureId) върне sendJSON(res, 400, { грешка: 'missing_fixture' });

      const cacheKey = 'травми:' + fixtureId;
      const кеширан = getCached(кешКейч, 600000);
      ако (кеширано) върне sendJSON(res, 200, кеширано);

      опитай {
        const данни = чакам apiFetch('/injuries?fixture=' + fixtureId);
        const играчи = (данни.отговор || []).map(i => ({
          играч: i.player ? i.player.name : '',
          отбор: i.team ? i.team.name : '',
          причина: i.player ? i.player.причина : '',
          тип: i.player ? i.player.type : ''
        }));
        const резултат = { брой: играчи.дължина, играчи: играчи };
        setCached(кешКлюч, резултат);
        връщане на sendJSON(res, 200, резултат);
      } улов (грешка) {
        връщане на sendJSON(res, 200, {брой: 0, играчи: [] });
      }
    }

    ако (маршрут === '/api/predict' && метод === 'POST') {
      ако (!API_KEY) върне sendJSON(res, 500, {грешка: 'no_key' });
      const тяло = изчакване на readBody(req);
      const homeName = (body.home || '').trim();
      const awayName = (body.away || '').trim();
      ако (!homeName || !awayName) върне sendJSON(res, 400, { грешка: 'missing_teams' });

      // кеш по двойката отбори (за 10 мин), за да пестим заявки
      const cacheKey = 'предсказване:' + homeName.toLowerCase() + ':' + awayName.toLowerCase();
      const кеширан = getCached(кешКейч, 600000);
      ако (кеширано) върне sendJSON(res, 200, кеширано);

      // 1) Намираме двата отбора
      const домашенЕкип = изчакване на намиранеЕкип(имеНаКупване);
      ако (!homeTeam) върне sendJSON(res, 404, { грешка: 'home_not_found', име: homeName });
      const awayTeam = изчакване на findTeam(awayName);
      ако (!awayTeam) върне sendJSON(res, 404, { грешка: 'away_not_found', име: awayName });

      // 2) Тегли форма и директни срещи
      const[homeForm, awayForm, h2h] = await Promise.all([
        getTeamForm(началенTeam.id, 5),
        getTeamForm(awayTeam.id, 5),
        getH2H(homeTeam.id, awayTeam.id, 5)
      ]);

      // 3) Смятаме прогнозата (с обучените тежести)
      const тегла = изчакване getWeights();
      константна прогноза = изчислиПредположение(
        Object.assign({ име: homeTeam.name }, homeForm),
        Object.assign({ име: awayTeam.name }, awayForm),
        ч2ч,
        тежести
      );

      константен резултат = {
        начало: { id: homeTeam.id, име: homeTeam.name, лого: homeTeam.logo, държава: homeTeam.country, форма: homeForm },
        гост: { id: awayTeam.id, име: awayTeam.name, лого: awayTeam.logo, държава: awayTeam.country, форма: awayForm },
        ч2ч: ч2ч,
        прогноза: прогноза
      };
      setCached(кешКлюч, резултат);
      // проверяваме минали мачове за самообучение (фоново)
      провериИНаучи();
      връщане на sendJSON(res, 200, резултат);
    }

    // ---------- МОИТЕ ПРОГНОЗИ (реална статистика на AI) ----------
    ако (маршрут === '/api/моите-предсказания') {
      опитай {
        const w = await pool.query('SELECT total_checked, total_correct FROM ai_weights WHERE id = 1');
        const общо = w.rows[0] ? w.rows[0].total_checked : 0;
        const correct = w.rows[0] ? w.rows[0].total_correct : 0;
        const точност = общо > 0 ? Math.round((правилно / общо) * 1000) / 10 : 0;

        // тази седмица
        const седмица = чакам pool.query(
          `SELECT COUNT(*) FILTER (WHERE correct = true) AS correct, COUNT(*) AS total
           ОТ прогнози КЪДЕТО е проверено = true AND създадено_в > NOW() - ИНТЕРВАЛ '7 дни'`
        );
        const weekCorrect = parseInt(week.rows[0].correct) || 0;
        const ОбщоЗаСедмица = parseInt(седмица.редове[0].общо) || 0;

        // серия (последователни познати)
        const скорошни = чакам pool.query(
          `SELECT correct FROM predictions WHERE checked = true ORDER BY match_date DESC LIMIT 20`
        );
        нека ивица = 0;
        за (const ред от recent.rows) {
          ако (row.correct) streak++; иначе break;
        }

        върнете sendJSON(res, 200, {
          седмицаТочно, седмицаОбщо,
          totalChecked: общо, totalCorrect: правилно, точност,
          ивица
        });
      } улов (e) {
        връщане на sendJSON(res, 200, { weekCorrect: 0, weekTotal: 0, totalChecked: 0, totalCorrect: 0, accuracy: 0, streak: 0 });
      }
    }

    // ---------- СИГУРНИ ЗАЛОЗИ (висока увереност, предстоящи + живи) ----------
    ако (маршрут === '/api/сигурни-залози') {
      ако (!API_KEY) върне sendJSON(res, 500, {грешка: 'no_key' });
      const cached = getCached('сигурни-залози', 300000); // 5 мин
      ако (кеширано) върне sendJSON(res, 200, кеширано);

      опитай {
        const тегла = изчакване getWeights();
        // вземаме живи + днешни мачове
        const[liveData, todayData] = изчакване Promise.all([
          apiFetch('/fixtures?live=all').catch(() => ({ отговор: [] })),
          apiFetch('/fixtures?date=' + new Date().toISOString().slice(0,10)).catch(() => ({ отговор: [] }))
        ]);
        нека фиксиращи устройства = [...(liveData.response || []), ...(todayData.response || [])];
        // махаме да публикувате по id
        константа се вижда = {};
        фиксиращи елементи = фиксиращи елементи.филтър(f => { ако (seen[f.fixture.id]) върне false; seen[f.fixture.id] = 1; върне true; });
        // ограничаваме до 25 за да не правим твърде много заявки
        фиксиращи елементи = фиксиращи елементи.slice(0, 25);

        const sureBets = [];
        за (const f от приспособленията) {
          const статус = f.fixture.status.short;
          // само предстоящи или живи (не свършили)
          ако (['FT','AET','PEN','PST','CANC'].includes(статус)) продължи;
          опитай {
            const [hForm, aForm] = await Promise.all([
              getTeamForm(f.teams.home.id, 5),
              getTeamForm(f.teams.away.id, 5)
            ]);
            const pred = computePrediction(
              Object.assign({ име: f.teams.home.name }, hForm),
              Object.assign({ име: f.teams.away.name }, aForm),
              нула, тегла
            );
            // "сигурен" = увереност >= 60% и достатъчно данни
            ако (pred.confidence >= 60 && hForm.played >= 3 && aForm.played >= 3) {
              const isLive = ['1H','HT','2H','ET','BT','P','LIVE'].includes(статус);
              sureBets.push({
                идентификатор на фиксиращ елемент: f.fixture.id,
                лига: f.league.name, флаг: f.league.flag,
                домакин: f.teams.home.name, гост: f.teams.away.name,
                homeЛого: f.teams.home.logo, awayЛого: f.teams.away.logo,
                дата: f.fixture.date, isLive,
                избор: предвар.избор, тип избор: предвар.тип избор,
                увереност: предварителна увереност,
                домашенПкт: пред.домашенПкт, тегленеПкт: пред.тегленеПкт, гостенПкт: пред.гостенПкт
              });
              // записваме прогнозата за самообучение
              savePrediction(f.fixture.id, f.teams.home.name, f.teams.away.name, f.league.name, f.fixture.date, pred);
            }
          } catch (e) { продължи; }
          if (sureBets.length >= 10) прекъсване; // максимум 10
        }
        // подреждаме по увереност
        sureBets.sort((a, b) => b.доверие - a.доверие);
        const резултат = { брой: sureBets.length, залози: sureBets };
        setCached('сигурни-залози', резултат);
        провериИНаучи();
        връщане на sendJSON(res, 200, резултат);
      } улов (e) {
        връщане на sendJSON(res, 200, {брой: 0, залози: [] });
      }
    }

    връщане на sendJSON(res, 404, {грешка: 'not_found' });
  } улов (грешка) {
    console.error('API грешка (' + route + '):', err.message);
    връщане на sendJSON(res, 500, { грешка: 'server_error' });
  }
}

// ==================================================================
// Стартиране на сървъра
// ==================================================================
const сървър = http.createServer((req, res) => {
  const url = нов URL(req.url, 'http://' + req.headers.host);
  const маршрут = url.път;
  ако (route.startsWith('/api/')) { handleApi(req, res, route, req.method); return; }
  // броим посещение само при зареждане на главната страница
  ако (маршрут === '/' || маршрут === '/index.html') {
    recordVisit(req); // не чакаме - върви фоново
  }
  нека filePath = path.join(PUBLIC_DIR, маршрут === '/' ? 'index.html' : маршрут);
  ако (!filePath.startsWith(PUBLIC_DIR)) filePath = път.присъединяване(PUBLIC_DIR, 'index.html');
  serveStatic(res, filePath);
});

initDatabase().then(() => {
  сървър.listen(ПОРТ, () => {
    console.log('GoalMind сървърът работи на порт ' + PORT);
    if (!API_KEY) console.warn('⚠️ Липсва API_FOOTBALL_KEY');
    ако (!process.env.URL_НА_БАЗАТА_ДАННИ) console.warn('⚠️ Изгубен URL_НА_БАЗА_ДАННИ');
  });
});
