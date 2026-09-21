// Stable local-time cycle identity. This selects a slot; the Codex heartbeat
// remains the actual scheduler. Date-only IDs retain their historical meaning.
const idPattern = /^(\d{4}-\d{2}-\d{2})(?:-([01]\d|2[0-3])([0-5]\d))?$/;

export function isRunId(id) {
  if (typeof id !== 'string') return false;
  const match = idPattern.exec(id);
  if (!match) return false;
  const parsed = new Date(`${match[1]}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === match[1];
}

export function assertRunId(id) {
  if (!isRunId(id)) throw new Error('runId must be a valid YYYY-MM-DD or YYYY-MM-DD-HHMM cycle ID.');
  return id;
}

export function runDate(id) { return assertRunId(id).slice(0, 10); }

export function localDate(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function scheduledHours(config) {
  if (config.dailyHours === undefined) return null;
  const hours = config.dailyHours;
  if (!Array.isArray(hours) || hours.length === 0 || hours.length > 24
    || hours.some((hour, index) => !Number.isInteger(hour) || hour < 0 || hour > 23
      || (index > 0 && hour <= hours[index - 1]))) {
    throw new Error('dailyHours must be a nonempty, ascending list of unique hours from 0 to 23.');
  }
  return [...hours];
}

export function cycleSlot(now, config) {
  let date = localDate(now, config.timezone);
  const hours = scheduledHours(config);
  if (!hours) return { id: date, date, hour: null };
  const hourNow = Number(new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone, hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).find(part => part.type === 'hour').value);
  let hour = hours.findLast(value => value <= hourNow);
  if (hour === undefined) {
    // Calendar arithmetic on the already-local date avoids 23/25-hour DST days.
    const previous = new Date(`${date}T00:00:00.000Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    date = previous.toISOString().slice(0, 10);
    hour = hours.at(-1);
  }
  return { id: `${date}-${String(hour).padStart(2, '0')}00`, date, hour };
}
