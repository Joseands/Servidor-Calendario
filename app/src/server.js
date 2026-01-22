'use strict';

const fs = require('fs');
const express = require('express');

require('dotenv').config({ path: '/opt/ff-news/.env' });

const HOST = '127.0.0.1';
const PORT = Number(process.env.BACKEND_PORT || 8081);

const CACHE_FILE = process.env.CACHE_FILE || '/opt/ff-news/cache/latest.json';
const INGEST_LOG  = '/opt/ff-news/logs/ingest.log';

const REFRESH_SECONDS = 300;
const STALE_GRACE_SECONDS = 60;

function nowUtcIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function nowMs() {
  return Date.now();
}
function clampInt(n, min, max) {
  n = Number.isFinite(n) ? n : min;
  return Math.max(min, Math.min(max, n));
}

function safeReadText(filePath) {
  try {
    return { ok: true, text: fs.readFileSync(filePath, 'utf8') };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function safeReadJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw || '{}');
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function fileStat(filePath) {
  try {
    const st = fs.statSync(filePath);
    const mtimeMs = st.mtimeMs;
    return {
      exists: true,
      bytes: st.size,
      mtime_utc: new Date(mtimeMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      age_sec: Math.max(0, Math.floor((nowMs() - mtimeMs) / 1000)),
    };
  } catch (_) {
    return { exists: false, bytes: 0, mtime_utc: null, age_sec: null };
  }
}

function cacheFreshness() {
  const st = fileStat(CACHE_FILE);
  const staleAfter = REFRESH_SECONDS + STALE_GRACE_SECONDS;
  const stale = !st.exists || typeof st.age_sec !== 'number' || st.age_sec > staleAfter;

  return {
    ...st,
    refresh_seconds: REFRESH_SECONDS,
    stale_grace_seconds: STALE_GRACE_SECONDS,
    stale,
  };
}

function parseIngestLogTail(maxLines) {
  maxLines = clampInt(maxLines, 10, 2000);

  const r = safeReadText(INGEST_LOG);
  if (!r.ok) {
    return { ok: false, error: r.error, last_ok_utc: null, last_error_utc: null, last_error_msg: null };
  }

  const lines = r.text.trim().split('\n');
  const tail = lines.slice(-maxLines);

  let lastOk = null;
  let lastErr = null;
  let lastErrMsg = null;

  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];

    if (!lastOk && line.includes(' ingest_ok ')) {
      lastOk = (line.split(' ')[0] || null);
    }
    if (!lastErr && line.includes(' ingest_error ')) {
      lastErr = (line.split(' ')[0] || null);
      const idx = line.indexOf('err=');
      if (idx >= 0) lastErrMsg = line.slice(idx + 4).trim() || null;
    }
    if (lastOk && lastErr) break;
  }

  return { ok: true, error: null, last_ok_utc: lastOk, last_error_utc: lastErr, last_error_msg: lastErrMsg };
}

function normalizeCalendarObject(obj, st, readErr) {
  // Si falla lectura, devolvemos estructura contrato vacía con meta de error
  if (!obj) {
    return {
      meta: {
        generated_at_utc: nowUtcIso(),
        source: 'ForexFactory calendar',
        count: 0,
        cache_file: CACHE_FILE,
        cache_exists: st.exists,
        cache_mtime_utc: st.mtime_utc,
        cache_age_sec: st.age_sec,
        error: readErr || 'unknown',
      },
      events: [],
    };
  }

  // Si el cache accidentalmente es un array, lo envolvemos
  if (Array.isArray(obj)) {
    return {
      meta: {
        generated_at_utc: nowUtcIso(),
        source: 'ForexFactory calendar',
        count: obj.length,
        cache_file: CACHE_FILE,
        cache_exists: st.exists,
        cache_mtime_utc: st.mtime_utc,
        cache_age_sec: st.age_sec,
        note: 'cache_was_array_wrapped',
      },
      events: obj,
    };
  }

  // Objeto esperado
  const data = obj && Object.keys(obj).length ? obj : { meta: {}, events: [] };
  if (!data.meta) data.meta = {};
  if (!Array.isArray(data.events)) data.events = [];

  if (!data.meta.generated_at_utc) data.meta.generated_at_utc = nowUtcIso();
  if (!data.meta.source) data.meta.source = 'ForexFactory calendar';
  if (typeof data.meta.count !== 'number') data.meta.count = data.events.length;

  data.meta.cache_file = CACHE_FILE;
  data.meta.cache_exists = st.exists;
  data.meta.cache_mtime_utc = st.mtime_utc;
  data.meta.cache_age_sec = st.age_sec;

  return data;
}

function buildCalendarResponse() {
  const st = fileStat(CACHE_FILE);
  const read = safeReadJson(CACHE_FILE);

  if (!read.ok) {
    return { statusCode: 503, body: normalizeCalendarObject(null, st, read.error) };
  }

  return { statusCode: 200, body: normalizeCalendarObject(read.data, st, null) };
}

function toEpochSecondsFromIso(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function impactForEA(impact) {
  // impact del contrato: low|medium|high|holiday|unknown
  const x = String(impact || '').toLowerCase();
  if (x === 'high') return 'High';
  if (x === 'medium') return 'Medium';
  if (x === 'low') return 'Low';
  if (x === 'holiday') return 'High';   // decisión práctica: feriados bloquean como High
  return 'Low';                          // unknown -> Low para no romper EA
}

function buildLatestArrayForEA(calendarObj) {
  // calendarObj es {meta,events} o, en casos raros, array
  const events = Array.isArray(calendarObj) ? calendarObj : (Array.isArray(calendarObj.events) ? calendarObj.events : []);

  const out = [];
  for (const e of events) {
    if (!e) continue;
    const currency = (e.currency || '').toString().trim();
    const title    = (e.title || e.event || '').toString().trim();

    // epoch: preferir e.epoch si viene; si no, derivar de datetime_utc
    let epoch = null;
    if (Number.isFinite(e.epoch)) epoch = e.epoch;
    else if (typeof e.epoch === 'string' && /^\d+$/.test(e.epoch)) epoch = Number(e.epoch);
    if (!Number.isFinite(epoch)) epoch = toEpochSecondsFromIso(e.datetime_utc);

    if (!currency || !title || !Number.isFinite(epoch)) continue;

    out.push({
      currency,
      impact: impactForEA(e.impact),
      title,
      epoch,
    });
  }

  // Orden ascendente por tiempo
  out.sort((a, b) => a.epoch - b.epoch);
  return out;
}

const app = express();
app.disable('x-powered-by');

// Health (negocio): backend vivo + cache fresco
app.get('/v1/health', (req, res) => {
  const c = cacheFreshness();
  const statusCode = c.stale ? 503 : 200;

  res.status(statusCode).json({
    status: c.stale ? 'degraded' : 'ok',
    time_utc: nowUtcIso(),
    cache: c,
  });
});

// Alias útil (por si lo llamas directo al backend)
app.get('/health', (req, res) => {
  const c = cacheFreshness();
  const statusCode = c.stale ? 503 : 200;

  res.status(statusCode).json({
    status: c.stale ? 'degraded' : 'ok',
    time_utc: nowUtcIso(),
    cache: c,
  });
});

// Status completo
app.get('/v1/status', (req, res) => {
  const c = cacheFreshness();
  const cacheJson = safeReadJson(CACHE_FILE);

  let generatedAt = null;
  if (cacheJson.ok && cacheJson.data && cacheJson.data.meta && cacheJson.data.meta.generated_at_utc) {
    generatedAt = cacheJson.data.meta.generated_at_utc;
  }

  const ingest = parseIngestLogTail(300);

  res.json({
    status: 'ok',
    time_utc: nowUtcIso(),
    uptime_sec: Math.floor(process.uptime()),
    cache: {
      path: CACHE_FILE,
      exists: c.exists,
      bytes: c.bytes,
      mtime_utc: c.mtime_utc,
      age_sec: c.age_sec,
      refresh_seconds: c.refresh_seconds,
      stale_grace_seconds: c.stale_grace_seconds,
      stale: c.stale,
      json_read_ok: cacheJson.ok,
      json_error: cacheJson.ok ? null : cacheJson.error,
    },
    ingest: {
      generated_at_utc: generatedAt,
      log_ok: ingest.ok,
      log_error: ingest.error,
      last_ok_utc: ingest.last_ok_utc,
      last_error_utc: ingest.last_error_utc,
      last_error_msg: ingest.last_error_msg,
    }
  });
});

// Contrato v1 (calendar)
app.get('/v1/calendar', (req, res) => {
  const out = buildCalendarResponse();
  res.status(out.statusCode).json(out.body);
});

// /api/health (compat)
app.get('/api/health', (req, res) => {
  const c = cacheFreshness();
  const statusCode = c.stale ? 503 : 200;

  res.status(statusCode).json({
    status: c.stale ? 'degraded' : 'ok',
    service: 'ff-news-api',
    time_utc: nowUtcIso(),
    cache: c,
  });
});

// Endpoint exacto para el EA (array)
app.get('/api/news/latest.json', (req, res) => {
  const out = buildCalendarResponse();
  const arr = buildLatestArrayForEA(out.body);
  res.status(out.statusCode).json(arr);
});

// /api/news y cualquier /api/news/... (devuelve contrato completo)
app.get(/^\/api\/news(?:\/.*)?$/, (req, res) => {
  // OJO: Express 5 rompe con "/api/news/*" => por eso usamos regex
  const out = buildCalendarResponse();
  res.status(out.statusCode).json(out.body);
});

app.get('/metrics', (req, res) => {
  const c = cacheFreshness();
  const cacheJson = safeReadJson(CACHE_FILE);

  let count = 0;
  if (cacheJson.ok && cacheJson.data && Array.isArray(cacheJson.data.events)) {
    count = cacheJson.data.events.length;
  }

  const ingest = parseIngestLogTail(300);
  let lastOkEpoch = 0;
  if (ingest.last_ok_utc) {
    const t = Date.parse(ingest.last_ok_utc);
    if (!Number.isNaN(t)) lastOkEpoch = Math.floor(t / 1000);
  }

  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send(
`ffnews_cache_age_seconds ${Number.isFinite(c.age_sec) ? c.age_sec : 0}
ffnews_cache_events_count ${count}
ffnews_ingest_last_ok_epoch ${lastOkEpoch}
ffnews_service_uptime_seconds ${Math.floor(process.uptime())}
`
  );
});

app.listen(PORT, HOST, () => {
  console.log(`[ff-news-api] listening on http://${HOST}:${PORT} cache=${CACHE_FILE}`);
});
