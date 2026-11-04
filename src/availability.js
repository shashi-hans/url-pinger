'use strict';

// When a target's interval timer may hit it, in IST:
//   - onlineFrom/onlineTo: daily online window as 24-hour "HH:MM". Outside it
//     the timer keeps running but skips its hits. Null for always online.
//   - offlineDays: weekdays with no timed hits at all, 0 = Sunday .. 6 =
//     Saturday, checked against the current IST calendar day. So with a
//     9 PM to 6 AM window and Sunday offline, Saturday's window stops at
//     midnight and Sunday's window does not run.
// Manual "Run now" ignores both.
//
// IST is a fixed UTC+05:30 offset with no daylight saving, so a constant
// offset gives the same result as an Asia/Kolkata timezone lookup.

const IST_OFFSET_MS = 330 * 60 * 1000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const TIME_12H_RE = /^(1[0-2]|0?[1-9]):([0-5]\d)\s*([AaPp])\.?[Mm]\.?$/;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Display order: the week starts on Monday. Stored numbers keep 0 = Sunday.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

function parseTime(value) {
  const m = typeof value === 'string' ? TIME_RE.exec(value) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Accepts "HH:MM" (24-hour) or "h:mm AM/PM" and returns "HH:MM", or null
// when the value is neither.
function normalizeTime(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (TIME_RE.test(v)) return v;
  const m = TIME_12H_RE.exec(v);
  if (!m) return null;
  const hour12 = Number(m[1]) % 12;
  const hour = m[3].toLowerCase() === 'p' ? hour12 + 12 : hour12;
  return `${String(hour).padStart(2, '0')}:${m[2]}`;
}

// "HH:MM" -> { hour: 1..12, minute: "MM", period: "AM" | "PM" }, or null.
function toParts12(value) {
  const minutes = parseTime(value);
  if (minutes === null) return null;
  const h24 = Math.floor(minutes / 60);
  return {
    hour: h24 % 12 === 0 ? 12 : h24 % 12,
    minute: String(minutes % 60).padStart(2, '0'),
    period: h24 < 12 ? 'AM' : 'PM',
  };
}

// "HH:MM" -> "h:mm AM". Returns '' for a missing or malformed value.
function format12(value) {
  const p = toParts12(value);
  return p ? `${p.hour}:${p.minute} ${p.period}` : '';
}

function istNow(date) {
  return new Date(date.getTime() + IST_OFFSET_MS);
}

function istMinutesOfDay(date = new Date()) {
  const ist = istNow(date);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function istDay(date = new Date()) {
  return istNow(date).getUTCDay();
}

// The window includes its start minute and excludes its end minute. A start
// later than the end crosses midnight (21:00 to 06:00).
function insideWindow(from, to, now) {
  return from < to ? now >= from && now < to : now >= from || now < to;
}

// True when the timer must skip this target right now.
function isOffline(target, date = new Date()) {
  if (Array.isArray(target.offlineDays) && target.offlineDays.includes(istDay(date))) return true;
  const from = parseTime(target.onlineFrom);
  const to = parseTime(target.onlineTo);
  if (from === null || to === null || from === to) return false;
  return !insideWindow(from, to, istMinutesOfDay(date));
}

module.exports = {
  TIME_RE,
  DAY_NAMES,
  WEEK_ORDER,
  parseTime,
  normalizeTime,
  toParts12,
  format12,
  istMinutesOfDay,
  istDay,
  isOffline,
};
