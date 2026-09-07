/**
 * THE HOME HUB - Google Apps Script backend  (v5)
 * ------------------------------------------------------------------
 * Deploy: Deploy > New deployment > Web app
 *   Execute as:      Me
 *   Who has access:  Anyone
 *
 * AFTER ANY EDIT HERE YOU MUST RE-DEPLOY:
 *   Deploy > Manage deployments > pencil > Version: New version > Deploy
 *
 * Endpoints (GET, all require ?token=...):
 *   ?token=X                              -> full payload
 *   ?token=X&action=toggleHabit&id=H
 *   ?token=X&action=completeTask&list=L&id=I
 *   ?token=X&action=completeChore&id=C
 *   ?token=X&action=ping
 *
 * The logical day rolls at RESET_HOUR (04:00), not midnight.
 */

/* ============================ CONFIG ============================= */

var CFG = {
  TOKEN: 'YOUR_LONG_RANDOM_TOKEN',   // set this in the Apps Script editor

  RESET_HOUR: 4,
  HIST_DAYS: 60,          // per-habit history (7 shown, rest feeds streaks)
  SCORE_DAYS: 200,        // daily activity totals kept for the graph
  GRAPH_WEEKS: 26,        // columns in the contribution graph (~6 months)
  MAX_MERGED: 9,
  WEEK_DAYS: 7,
  WEEK_MAX_PER_DAY: 6,

  /* ---- Calendars ---------------------------------------------------
   * ALL of your calendars are read. Add exact names here to skip the
   * noisy ones - holiday feeds, birthdays, subscribed sports fixtures.
   * Case-insensitive, matched on the calendar's display name.          */
  EXCLUDE_CALENDARS: [
    'Holidays in Lithuania',
    'Birthdays',
    'Week Numbers'
  ],

  PEOPLE: ['Me', 'Partner'],

  HABITS: [
    { id: 'bed',     label: 'Make bed' },
    { id: 'water',   label: 'Drink 500ml water' },
    { id: 'face',    label: 'Wash face / skincare' },
    { id: 'top3',    label: 'Set top 3 priorities' },
    { id: 'deep',    label: 'Deep work block' },
    { id: 'study',   label: 'Internship / study' },
    { id: 'walk',    label: 'Walk 8k steps' },
    { id: 'kitchen', label: 'Kitchen reset' },
    { id: 'plan',    label: 'Plan tomorrow' },
    { id: 'read',    label: 'Read on paper' },
    { id: 'lights',  label: 'Lights out by 23:00' }
  ],

  CHORES: [
    { id: 'w1', weekday: 3, who: 0, label: 'Sweep + mop kitchen & hallway' },
    { id: 'w2', weekday: 3, who: 1, label: 'Wipe counters, hob & sink' },
    { id: 'w3', weekday: 3, who: 1, label: 'Bathroom sink + mirror' },
    { id: 'w4', weekday: 3, who: 0, label: 'Rubbish + recycling out' },

    { id: 'f1', weekday: 5, who: 0, label: 'Sweep + mop all rooms' },
    { id: 'f2', weekday: 5, who: 1, label: 'Bathroom: toilet, shower, tiles' },
    { id: 'f3', weekday: 5, who: 0, label: 'Change bedsheets' },
    { id: 'f4', weekday: 5, who: 1, label: 'Dust surfaces & shelves' },
    { id: 'f5', weekday: 5, who: 0, label: 'Laundry load' }
  ],

  DEEP_CLEAN: [
    { id: 'p1', week: 1, label: 'Clean fridge inside' },
    { id: 'p2', week: 2, label: 'Oven + microwave inside' },
    { id: 'p3', week: 3, label: 'Washing machine drawer + filter' },
    { id: 'p4', week: 4, label: 'Windows + mirrors' }
  ],

  BINS: [
    { label: 'General waste', weekday: 3 },
    { label: 'Recycling',     weekday: 5 }
  ],

  COUNTDOWN_CALENDAR: 'Countdowns',
  COUNTDOWN_MAX: 2,

  WEATHER: { enabled: true, lat: 54.6872, lon: 25.2797 }   // Vilnius
};

/* ============================ ROUTING ============================ */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.token !== CFG.TOKEN) return json({ ok: false, error: 'unauthorized' });

  try {
    switch (p.action) {
      case 'toggleHabit':   return json(toggleHabit_(p.id));
      case 'completeTask':  return json(completeTask_(p.list, p.id));
      case 'completeChore': return json(completeChore_(p.id));
      case 'ping':          return json({ ok: true, pong: true });
      default:              return json(buildPayload_());
    }
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doPost(e) { return doGet(e); }

/* ======================== LOGICAL DAY (04:00) ==================== */

function logicalDay_(tz, when) {
  var d = when || new Date();
  return Utilities.formatDate(
    new Date(d.getTime() - CFG.RESET_HOUR * 3600000), tz, 'yyyy-MM-dd');
}

function parseIso_(iso) {
  var p = iso.split('-');
  return new Date(+p[0], +p[1] - 1, +p[2]);
}

function shiftDay_(iso, days, tz) {
  var d = parseIso_(iso);
  d.setDate(d.getDate() + days);
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

function daysBetween_(isoA, isoB) {
  return Math.round((parseIso_(isoB) - parseIso_(isoA)) / 86400000);
}

/* ============================ PAYLOAD ============================ */

/*
 * Cached for 45s. The ESP32 syncs every 15 min, so this exists purely so
 * that a retry after a timeout is instant instead of rebuilding
 * everything. Any mutating action drops it (see dropCache_).
 *
 * Safe to cache: the ESP32 renders the clock from its own NTP time and
 * the countdown from the event's raw epoch, so nothing here goes stale
 * on screen within 45 seconds.
 */
function buildPayload_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('payload');
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }

  var t0 = new Date().getTime();
  var tz = Session.getScriptTimeZone();
  var now = new Date();
  var day = logicalDay_(tz, now);
  var st = habitState_(tz, day);

  /* ONE pass over every calendar for the next fortnight. Both the week
     grid and Next Up are derived from it - querying per-window per
     calendar was five full scans per sync and timed the ESP32 out. */
  var midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var hits = fetchEvents_(midnight, new Date(midnight.getTime() + 14 * 86400000));

  var payload = {
    ok:         true,
    clock:      Utilities.formatDate(now, tz, 'HH:mm'),
    date:       Utilities.formatDate(now, tz, 'EEEE, d MMMM'),
    nextUp:     nextFrom_(hits, tz, now),
    merged:     getMerged_(tz, now, day),
    week:       weekFrom_(hits, tz, now, midnight),
    habits:     getHabits_(st),
    graph:      buildGraph_(tz, day, st),
    bins:       getBins_(now),
    countdowns: getCountdowns_(tz, now),
    weather:    getWeather_(tz)
  };

  payload.ms = new Date().getTime() - t0;    // shown in the ESP32 log
  cache.put('payload', JSON.stringify(payload), 45);
  return payload;
}

/** Any write invalidates the cached payload. */
function dropCache_() {
  try { CacheService.getScriptCache().remove('payload'); } catch (e) {}
}

/* =========================== CALENDARS =========================== */
/*
 * EVERY calendar, not just the default one. Each calendar costs one
 * getEvents() call over the whole window, and the results are bucketed
 * locally - querying per-day-per-calendar would be 7x the API calls.
 */

/* getAllCalendars() is expensive, so it happens at most once per
   execution. Without this it ran on every fetchEvents_ call. */
var _cals = null;

function activeCalendars_() {
  if (_cals) return _cals;

  var skip = {};
  CFG.EXCLUDE_CALENDARS.forEach(function (n) { skip[String(n).toLowerCase()] = true; });

  _cals = CalendarApp.getAllCalendars().filter(function (c) {
    return !skip[String(c.getName()).toLowerCase()];
  });
  return _cals;
}

/** All events from all calendars in [start, end), sorted by start time. */
function fetchEvents_(start, end) {
  var out = [];

  activeCalendars_().forEach(function (cal) {
    var name = cal.getName();
    cal.getEvents(start, end).forEach(function (ev) {
      out.push({ ev: ev, cal: name, t: ev.getStartTime().getTime() });
    });
  });

  out.sort(function (a, b) { return a.t - b.t; });
  return out;
}

/*
 * The very next event, picked out of the fortnight pass we already did.
 * Only if the next two weeks are genuinely empty do we pay for a second,
 * wider sweep - so the normal case is ONE multi-calendar query per sync.
 *
 * `epoch` is sent raw so the ESP32 recomputes the countdown on every
 * page load - otherwise it would only be right at the moment of sync.
 */
function pickNext_(hits, tz, now) {
  for (var i = 0; i < hits.length; i++) {
    var ev = hits[i].ev;
    var start = ev.getStartTime();
    if (start.getTime() <= now.getTime()) continue;      // already running

    return {
      title:  ev.getTitle(),
      cal:    hits[i].cal,
      day:    dayLabel_(start, tz, now),
      time:   ev.isAllDayEvent() ? 'All day'
                                 : Utilities.formatDate(start, tz, 'HH:mm'),
      loc:    (ev.getLocation() || '').substring(0, 40),
      epoch:  Math.floor(start.getTime() / 1000)
    };
  }
  return null;
}

function nextFrom_(hits, tz, now) {
  var soon = pickNext_(hits, tz, now);
  if (soon) return soon;

  var far = fetchEvents_(new Date(now.getTime() + 14 * 86400000),
                         new Date(now.getTime() + 365 * 86400000));
  return pickNext_(far, tz, now);
}

function dayLabel_(date, tz, now) {
  var f = function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };
  if (f(date) === f(now)) return 'Today';
  if (f(date) === f(new Date(now.getTime() + 86400000))) return 'Tomorrow';
  return Utilities.formatDate(date, tz, 'EEE d MMM');
}

/** 7 columns, bucketed from the fortnight pass. No extra queries. */
function weekFrom_(hits, tz, now, first) {
  var buckets = {};
  hits.forEach(function (hit) {
    var k = Utilities.formatDate(hit.ev.getStartTime(), tz, 'yyyy-MM-dd');
    (buckets[k] = buckets[k] || []).push(hit.ev);
  });

  var week = [];
  for (var d = 0; d < CFG.WEEK_DAYS; d++) {
    var day = new Date(first.getTime() + d * 86400000);
    var k = Utilities.formatDate(day, tz, 'yyyy-MM-dd');

    week.push({
      day:   Utilities.formatDate(day, tz, 'EEE'),
      num:   Utilities.formatDate(day, tz, 'd'),
      today: d === 0,
      events: (buckets[k] || []).slice(0, CFG.WEEK_MAX_PER_DAY).map(function (ev) {
        return {
          t: ev.isAllDayEvent() ? '' : Utilities.formatDate(ev.getStartTime(), tz, 'HH:mm'),
          n: ev.getTitle()
        };
      })
    });
  }
  return week;
}

/* ======================== MERGED TASK LIST ======================= */

function getMerged_(tz, now, day) {
  var out = [];

  var wd = now.getDay();
  var chores = CFG.CHORES.filter(function (c) { return c.weekday === wd; });

  if (wd === 5) {
    var wom = Math.min(4, Math.floor((now.getDate() - 1) / 7) + 1);
    CFG.DEEP_CLEAN.forEach(function (p) {
      if (p.week === wom) chores.push({ id: p.id, who: null, label: p.label });
    });
  }

  if (chores.length) {
    var st = choreState_(tz, day);
    var swap = weekParity_(now);

    chores.forEach(function (c) {
      if (st.done[c.id]) return;                    // ticked: gone for the day
      var who = '';
      if (c.who !== null && c.who !== undefined) {
        who = CFG.PEOPLE[swap ? (1 - c.who) : c.who] || '';
      }
      out.push({ kind: 'chore', id: c.id, title: c.label, due: '', src: who });
    });
  }

  var lists = Tasks.Tasklists.list({ maxResults: 100 }).items || [];
  var tasks = [];

  lists.forEach(function (l) {
    var res = Tasks.Tasks.list(l.id, {
      showCompleted: false, showHidden: false, maxResults: 100
    });
    (res.items || []).forEach(function (t) {
      if (t.status === 'completed' || !t.title || !t.title.trim()) return;
      tasks.push({
        id: t.id, list: l.id, title: t.title.trim(),
        dueRaw: t.due || '',
        due: t.due ? Utilities.formatDate(new Date(t.due), tz, 'd MMM') : '',
        src: l.title
      });
    });
  });

  tasks.sort(function (a, b) {
    if (a.dueRaw && b.dueRaw) return a.dueRaw < b.dueRaw ? -1 : (a.dueRaw > b.dueRaw ? 1 : 0);
    if (a.dueRaw) return -1;
    if (b.dueRaw) return 1;
    return 0;
  });

  tasks.forEach(function (t) {
    if (out.length >= CFG.MAX_MERGED) return;
    out.push({ kind: 'task', id: t.id, list: t.list,
               title: t.title, due: t.due, src: t.src });
  });

  return out.slice(0, CFG.MAX_MERGED);
}

function completeTask_(listId, taskId) {
  if (!taskId || !listId) return { ok: false, error: 'missing id' };
  Tasks.Tasks.patch({ status: 'completed' }, listId, taskId);
  bumpScore_(1);
  dropCache_();
  return { ok: true, done: taskId };
}

/* ============================ CHORES ============================= */

function weekParity_(now) {
  var monday = new Date(now.getFullYear(), now.getMonth(),
                        now.getDate() - ((now.getDay() + 6) % 7));
  return Math.floor(monday.getTime() / (7 * 86400000)) % 2 === 1;
}

function choreState_(tz, day) {
  var props = PropertiesService.getScriptProperties();
  var st;
  try { st = JSON.parse(props.getProperty('chores') || 'null'); } catch (e) { st = null; }

  if (!st || st.day !== day) {
    st = { day: day, done: {} };
    props.setProperty('chores', JSON.stringify(st));
  }
  return st;
}

function completeChore_(id) {
  if (!id) return { ok: false, error: 'no chore id' };
  var tz = Session.getScriptTimeZone();
  var st = choreState_(tz, logicalDay_(tz));

  st.done[id] = true;
  PropertiesService.getScriptProperties().setProperty('chores', JSON.stringify(st));
  bumpScore_(1);
  dropCache_();
  return { ok: true, id: id };
}

/* ============================ HABITS ============================= */
/*
 * Per-habit history is one fixed-length bit-string, index 0 = today.
 * Script Properties caps a single value at 9KB: 11 habits x 60 dates
 * would blow that, 11 x 60 chars is under a kilobyte.
 *
 * `score` is the separate daily activity total (habits + tasks + chores)
 * that feeds the contribution graph.
 */

function zeros_(n) { var s = ''; while (s.length < n) s += '0'; return s; }

function habitState_(tz, day) {
  var props = PropertiesService.getScriptProperties();
  var st;
  try { st = JSON.parse(props.getProperty('habits') || 'null'); } catch (e) { st = null; }
  if (!st || !st.hist) st = { day: day, hist: {}, score: {} };
  if (!st.score) st.score = {};

  if (st.day !== day) {
    var gap = daysBetween_(st.day, day);
    if (gap > 0) {
      if (gap > CFG.HIST_DAYS) gap = CFG.HIST_DAYS;
      Object.keys(st.hist).forEach(function (id) {
        st.hist[id] = (zeros_(gap) + st.hist[id]).substring(0, CFG.HIST_DAYS);
      });
    }
    st.day = day;

    // Drop score entries older than the graph window.
    var cutoff = shiftDay_(day, -CFG.SCORE_DAYS, tz);
    Object.keys(st.score).forEach(function (k) {
      if (k < cutoff) delete st.score[k];
    });
    props.setProperty('habits', JSON.stringify(st));
  }

  CFG.HABITS.forEach(function (h) {
    if (!st.hist[h.id]) st.hist[h.id] = zeros_(CFG.HIST_DAYS);
  });
  return st;
}

function saveHabitState_(st) {
  PropertiesService.getScriptProperties().setProperty('habits', JSON.stringify(st));
}

/** Adds to today's activity total. Used by habits, tasks and chores. */
function bumpScore_(delta) {
  var tz = Session.getScriptTimeZone();
  var day = logicalDay_(tz);
  var st = habitState_(tz, day);

  st.score[day] = Math.max(0, (st.score[day] || 0) + delta);
  saveHabitState_(st);
}

/**
 * "One skip allowed": the run only ends after TWO consecutive misses.
 * Today is neutral until ticked, so an untouched morning never shows a
 * broken streak.
 *
 * Recomputed from history every read rather than incremented, so
 * un-ticking, a missed sync or a clock change cannot corrupt it.
 */
function streakGrace_(s) {
  var streak = 0, misses = 0;
  for (var i = 0; i < s.length; i++) {
    if (s.charAt(i) === '1') { streak++; misses = 0; continue; }
    if (i === 0) continue;
    if (++misses >= 2) break;
  }
  return streak;
}

function getHabits_(st) {
  return CFG.HABITS.map(function (h) {
    var s = st.hist[h.id];
    return {
      id:     h.id,
      label:  h.label,
      done:   s.charAt(0) === '1',
      streak: streakGrace_(s),
      grid:   s.substring(0, 7).split('').reverse().join('')  // oldest left
    };
  });
}

function toggleHabit_(id) {
  if (!id) return { ok: false, error: 'no habit id' };

  var tz = Session.getScriptTimeZone();
  var day = logicalDay_(tz);
  var st = habitState_(tz, day);
  var s = st.hist[id];
  if (!s) return { ok: false, error: 'unknown habit' };

  var on = s.charAt(0) !== '1';
  st.hist[id] = (on ? '1' : '0') + s.substring(1);
  st.score[day] = Math.max(0, (st.score[day] || 0) + (on ? 1 : -1));
  saveHabitState_(st);
  dropCache_();

  return { ok: true, id: id, done: on };
}

/* ====================== CONTRIBUTION GRAPH ======================= */
/*
 * GitHub-style: one cell per day, darker with more done that day.
 * Emitted as 7 strings of GRAPH_WEEKS characters - rows are Mon..Sun,
 * columns are weeks, oldest on the left. '-' means a future cell.
 *
 * A digit, not a count, so the ESP32 renders without any arithmetic.
 */

function level_(n) {
  if (n <= 0) return '0';
  if (n <= 2) return '1';
  if (n <= 4) return '2';
  if (n <= 7) return '3';
  return '4';
}

function buildGraph_(tz, today, st) {
  var weeks = CFG.GRAPH_WEEKS;
  var d = parseIso_(today);
  var mondayOffset = (d.getDay() + 6) % 7;              // Mon=0 .. Sun=6
  var thisMonday = shiftDay_(today, -mondayOffset, tz);
  var firstMonday = shiftDay_(thisMonday, -(weeks - 1) * 7, tz);

  var rows = [], months = [];
  var lastMonth = '';

  for (var r = 0; r < 7; r++) {
    var line = '';
    for (var c = 0; c < weeks; c++) {
      var iso = shiftDay_(firstMonday, c * 7 + r, tz);
      line += (iso > today) ? '-' : level_(st.score[iso] || 0);

      if (r === 0) {
        var m = Utilities.formatDate(parseIso_(iso), tz, 'MMM');
        months.push(m === lastMonth ? '' : m);
        lastMonth = m;
      }
    }
    rows.push(line);
  }

  /* ---- stats, for the small print under the graph ---- */
  var total = 0, activeDays = 0, best = 0, bestDay = '';
  for (var i = 0; i < weeks * 7; i++) {
    var iso = shiftDay_(firstMonday, i, tz);
    if (iso > today) break;
    var n = st.score[iso] || 0;
    total += n;
    if (n > 0) activeDays++;
    if (n > best) { best = n; bestDay = Utilities.formatDate(parseIso_(iso), tz, 'd MMM'); }
  }

  // Consecutive active days ending today (today itself is allowed to be
  // empty - the day is not over yet).
  var dayStreak = 0;
  for (var k = 0; k < CFG.SCORE_DAYS; k++) {
    var iso2 = shiftDay_(today, -k, tz);
    if ((st.score[iso2] || 0) > 0) dayStreak++;
    else if (k > 0) break;
  }

  var elapsed = daysBetween_(firstMonday, today) + 1;
  var bestHabit = 0;
  CFG.HABITS.forEach(function (h) {
    var s2 = streakGrace_(st.hist[h.id] || '');
    if (s2 > bestHabit) bestHabit = s2;
  });

  return {
    rows: rows,
    months: months,
    stats: {
      total:      total,
      today:      st.score[today] || 0,
      activeDays: activeDays,
      elapsed:    elapsed,
      pct:        elapsed ? Math.round(activeDays * 100 / elapsed) : 0,
      avg:        elapsed ? (total / elapsed).toFixed(1) : '0',
      best:       best,
      bestDay:    bestDay,
      dayStreak:  dayStreak,
      bestHabit:  bestHabit
    }
  };
}

/* ======================= BINS & COUNTDOWNS ======================= */

function getBins_(now) {
  var today = now.getDay(), tomorrow = (today + 1) % 7, out = [];
  CFG.BINS.forEach(function (b) {
    if (b.weekday === today)         out.push({ label: b.label, when: 'today' });
    else if (b.weekday === tomorrow) out.push({ label: b.label, when: 'out tonight' });
  });
  return out;
}

function getCountdowns_(tz, now) {
  try {
    var cals = CalendarApp.getCalendarsByName(CFG.COUNTDOWN_CALENDAR);
    if (!cals.length) return [];

    var midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return cals[0].getEvents(now, new Date(now.getTime() + 365 * 86400000))
      .slice(0, CFG.COUNTDOWN_MAX)
      .map(function (ev) {
        var s = ev.getStartTime();
        var days = Math.round(
          (new Date(s.getFullYear(), s.getMonth(), s.getDate()) - midnight) / 86400000);
        return {
          title: ev.getTitle(),
          label: days <= 0 ? 'today' : (days === 1 ? 'tomorrow' : days + ' days')
        };
      });
  } catch (err) { return []; }
}

/* ============================ WEATHER ============================ */

function getWeather_(tz) {
  if (!CFG.WEATHER.enabled) return null;

  var cache = CacheService.getScriptCache();
  var hit = cache.get('weather3');
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }

  try {
    var url = 'https://api.open-meteo.com/v1/forecast'
      + '?latitude=' + CFG.WEATHER.lat + '&longitude=' + CFG.WEATHER.lon
      + '&current=temperature_2m,weather_code'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset'
      + '&timezone=auto&forecast_days=4';

    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;

    var d = JSON.parse(res.getContentText());
    var out = {
      now:  Math.round(d.current.temperature_2m) + '°',
      desc: wmo_(d.current.weather_code),
      hi:   Math.round(d.daily.temperature_2m_max[0]) + '°',
      lo:   Math.round(d.daily.temperature_2m_min[0]) + '°',
      sunrise: String(d.daily.sunrise[0]).substring(11, 16),
      sunset:  String(d.daily.sunset[0]).substring(11, 16),
      days: []
    };

    for (var i = 1; i < d.daily.time.length && out.days.length < 3; i++) {
      out.days.push({
        day:  Utilities.formatDate(new Date(d.daily.time[i] + 'T12:00:00'), tz, 'EEE'),
        desc: wmo_(d.daily.weather_code[i]),
        hi:   Math.round(d.daily.temperature_2m_max[i]) + '°',
        lo:   Math.round(d.daily.temperature_2m_min[i]) + '°'
      });
    }

    cache.put('weather3', JSON.stringify(out), 1800);
    return out;
  } catch (err) { return null; }
}

function wmo_(c) {
  if (c === 0) return 'Clear';
  if (c === 1) return 'Mostly clear';
  if (c === 2) return 'Part cloudy';
  if (c === 3) return 'Overcast';
  if (c === 45 || c === 48) return 'Fog';
  if (c >= 51 && c <= 57) return 'Drizzle';
  if (c >= 61 && c <= 67) return 'Rain';
  if (c >= 71 && c <= 77) return 'Snow';
  if (c >= 80 && c <= 82) return 'Showers';
  if (c === 85 || c === 86) return 'Snow showers';
  if (c >= 95) return 'Thunderstorm';
  return 'Code ' + c;
}

/* ============================ HELPERS ============================ */

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Run this after any change. It reports how long the payload takes to
 * build - the ESP32 gives up at 30s, so anything over ~10s means you
 * should add noisy calendars to CFG.EXCLUDE_CALENDARS.
 */
function testRun() {
  dropCache_();
  var t0 = new Date().getTime();
  var p = buildPayload_();
  Logger.log('BUILD TIME: ' + (new Date().getTime() - t0) + ' ms');
  Logger.log('calendars read: ' + activeCalendars_().length);
  Logger.log(JSON.stringify(p, null, 2));
}

/** Lists every calendar name, so you know what to put in EXCLUDE_CALENDARS. */
function listCalendars() {
  CalendarApp.getAllCalendars().forEach(function (c) { Logger.log(c.getName()); });
}

function resetHabits() {
  PropertiesService.getScriptProperties().deleteProperty('habits');
  Logger.log('habits + graph cleared');
}

function resetChores() {
  PropertiesService.getScriptProperties().deleteProperty('chores');
  Logger.log('chores cleared');
}
