'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { DateTime } = require('luxon');

require('dotenv').config({ path: '/opt/ff-news/.env' });

const CACHE_FILE = process.env.CACHE_FILE || '/opt/ff-news/cache/latest.json';
const LOG_FILE   = '/opt/ff-news/logs/ingest.log';

const SOURCE = 'ForexFactory calendar';

// Fuentes oficiales (semanal)
const URL_JSON = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const URL_XML  = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';

// Zona típica del calendario (fallback cuando viene date+time separado)
const SOURCE_TZ = 'America/New_York';

function nowUtcIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function logLine(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (_) {}
}

function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, filePath);
}

function normalizeImpact(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'high') return 'high';
  if (s === 'medium') return 'medium';
  if (s === 'low') return 'low';
  if (s === 'holiday') return 'holiday';
  return 'unknown';
}

function emptyToNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function parseEpochAny(o) {
  const keys = ['epoch', 'timestamp', 'time_stamp', 'timeStamp', 'unixtime', 'unix'];
  for (const k of keys) {
    const v = o?.[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      let n = Math.floor(v);
      if (n > 1e12) n = Math.floor(n / 1000);
      return n;
    }
    if (typeof v === 'string' && /^\d+$/.test(v)) {
      let n = Number(v);
      if (n > 1e12) n = Math.floor(n / 1000);
      return n;
    }
  }
  return null;
}

function parseIsoToUtc(dateIso) {
  const s = String(dateIso || '').trim();
  if (!s) return { epoch: null, isoUtc: null };
  // Si viene ISO con offset, respetar la zona del string (setZone:true) y pasar a UTC
  const dt = DateTime.fromISO(s, { setZone: true });
  if (!dt.isValid) return { epoch: null, isoUtc: null };
  const utc = dt.toUTC();
  return {
    epoch: Math.floor(utc.toSeconds()),
    isoUtc: utc.toISO({ suppressMilliseconds: true })
  };
}

function parseDateTimeToUtc(dateStr, timeStr) {
  const d = String(dateStr || '').trim();
  let t = String(timeStr || '').trim();

  if (!d) return { epoch: null, isoUtc: null };

  const tl = t.toLowerCase().replace(/\s+/g, '');
  if (!t || tl === 'all-day' || tl === 'allday' || tl === 'tentative' || tl === 'n/a') {
    t = '12:00am';
  }

  // soporta distintos formatos comunes
  const candidates = [
    { fmt: 'yyyy-LL-dd h:mma', val: `${d} ${t}` },
    { fmt: 'yyyy-LL-dd ha',    val: `${d} ${t}` },
    { fmt: 'yyyy-LL-dd H:mm',  val: `${d} ${t}` },

    { fmt: 'LL-dd-yyyy h:mma', val: `${d} ${t}` },
    { fmt: 'LL-dd-yyyy ha',    val: `${d} ${t}` },
    { fmt: 'LL-dd-yyyy H:mm',  val: `${d} ${t}` },

    { fmt: 'LL/dd/yyyy h:mma', val: `${d} ${t}` },
    { fmt: 'LL/dd/yyyy ha',    val: `${d} ${t}` },
    { fmt: 'LL/dd/yyyy H:mm',  val: `${d} ${t}` }
  ];

  for (const c of candidates) {
    const dt = DateTime.fromFormat(c.val, c.fmt, { zone: SOURCE_TZ });
    if (dt.isValid) {
      const utc = dt.toUTC();
      return {
        epoch: Math.floor(utc.toSeconds()),
        isoUtc: utc.toISO({ suppressMilliseconds: true })
      };
    }
  }

  return { epoch: null, isoUtc: null };
}

function makeId(currency, epoch, title) {
  const c = (currency || 'UNK').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'UNK';
  const e = Number.isFinite(epoch) ? String(epoch) : '0';
  const t = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'event';
  return `${c}-${e}-${t}`;
}

function toEvent(obj) {
  // JSON típico: country = "USD", date = ISO con offset, impact = "Low"
  const currency = String(obj.currency || obj.country || obj.ccy || '').trim().toUpperCase() || null;
  const title = String(obj.title || obj.event || obj.name || '').trim() || null;

  // 1) preferir epoch si existe
  let epoch = parseEpochAny(obj);
  let datetime_utc = null;

  if (epoch) {
    datetime_utc = DateTime.fromSeconds(epoch, { zone: 'utc' }).toISO({ suppressMilliseconds: true });
  } else {
    // 2) si date es ISO (contiene T), parse ISO
    const dateVal = obj.date || obj.Date || obj.datetime || obj.datetime_utc;
    const dateStr = String(dateVal || '').trim();

    if (dateStr.includes('T')) {
      const dtIso = parseIsoToUtc(dateStr);
      epoch = dtIso.epoch;
      datetime_utc = dtIso.isoUtc;
    } else {
      // 3) fallback: date + time separado
      const dt = parseDateTimeToUtc(obj.date || obj.Date, obj.time || obj.Time);
      epoch = dt.epoch;
      datetime_utc = dt.isoUtc;
    }
  }

  const impact = normalizeImpact(obj.impact || obj.Impact);

  return {
    id: makeId(currency, epoch, title),
    datetime_utc: datetime_utc || null,
    epoch: Number.isFinite(epoch) ? epoch : null,
    currency,
    impact,
    title,
    actual: emptyToNull(obj.actual),
    forecast: emptyToNull(obj.forecast),
    previous: emptyToNull(obj.previous),
    url: emptyToNull(obj.url)
  };
}

async function fetchJsonEvents() {
  const r = await axios.get(URL_JSON, {
    timeout: 20000,
    headers: { 'User-Agent': 'ff-news-ingest/1.0', 'Accept': 'application/json,text/plain,*/*' },
    responseType: 'json',
    validateStatus: () => true
  });

  if (r.status < 200 || r.status >= 300) throw new Error(`JSON HTTP ${r.status}`);
  if (!Array.isArray(r.data)) throw new Error('JSON payload is not an array');

  return r.data
    .map(toEvent)
    .filter(e => e.currency && e.title && e.datetime_utc && Number.isFinite(e.epoch));
}

async function fetchXmlEvents() {
  const r = await axios.get(URL_XML, {
    timeout: 20000,
    headers: { 'User-Agent': 'ff-news-ingest/1.0', 'Accept': 'application/xml,text/xml,*/*' },
    responseType: 'text',
    validateStatus: () => true
  });

  if (r.status < 200 || r.status >= 300) throw new Error(`XML HTTP ${r.status}`);

  const $ = cheerio.load(r.data, { xmlMode: true });
  const events = [];

  $('event').each((_, el) => {
    const get = (tag) => $(el).find(tag).first().text().trim();

    const obj = {
      country: get('country'),
      date: get('date'),
      time: get('time'),
      impact: get('impact'),
      title: get('title'),
      actual: get('actual'),
      forecast: get('forecast'),
      previous: get('previous'),
      url: get('url')
    };

    const ev = toEvent(obj);
    if (ev.currency && ev.title && ev.datetime_utc && Number.isFinite(ev.epoch)) events.push(ev);
  });

  return events;
}

(async () => {
  const ts = nowUtcIso();

  try {
    let events = [];
    try {
      events = await fetchJsonEvents();
    } catch (eJson) {
      events = await fetchXmlEvents();
    }

    // orden por epoch
    events.sort((a, b) => a.epoch - b.epoch);

    const out = {
      meta: {
        generated_at_utc: ts,
        source: SOURCE,
        count: events.length
      },
      events
    };

    atomicWriteJson(CACHE_FILE, out);
    logLine(`${ts} ingest_ok count=${events.length}`);
    process.exit(0);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    logLine(`${ts} ingest_error err=${msg}`);
    process.exit(1);
  }
})();
