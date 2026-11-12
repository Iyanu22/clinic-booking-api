const EMAIL =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?$/;

const isBlank = (value) => typeof value !== 'string' || value.trim() === '';

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeEmail(value) {
  return value.trim().toLowerCase();
}

// Returns { error } or { booking } with the trimmed, lower-cased values to store.
export function validateNewBooking(body) {
  if (isBlank(body.slot_id)) return { error: 'slot_id is required' };
  if (isBlank(body.name)) return { error: 'name is required' };
  if (isBlank(body.email)) return { error: 'email is required' };

  if (CONTROL_CHARS.test(body.slot_id)) return { error: 'slot_id is invalid' };

  const name = body.name.trim();
  if (name.length > 200 || CONTROL_CHARS.test(name)) return { error: 'name is invalid' };

  const email = normalizeEmail(body.email);
  if (email.length > 254 || !EMAIL.test(email)) return { error: 'email is invalid' };

  return { booking: { slotId: body.slot_id, name, email } };
}

// A timestamp with no offset is read as UTC. Returns a Date, or null if unparseable.
function parseTimestamp(value) {
  if (typeof value !== 'string' || !ISO_DATE_TIME.test(value)) return null;
  const hasOffset = /([Zz]|[+-]\d{2}:\d{2})$/.test(value);
  const date = new Date(hasOffset ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Returns { error } or { slots } ready to insert.
export function validateSlots(body) {
  if (!isPlainObject(body) || !Array.isArray(body.slots)) {
    return { error: 'slots must be an array' };
  }

  const seen = new Set();
  const slots = [];
  for (const [index, slot] of body.slots.entries()) {
    const label = `slots[${index}]`;
    if (!isPlainObject(slot)) return { error: `${label} must be an object` };
    if (isBlank(slot.id) || slot.id.includes('\0')) return { error: `${label}.id is invalid` };
    if (isBlank(slot.provider) || slot.provider.includes('\0')) {
      return { error: `${label}.provider is invalid` };
    }
    const startAt = parseTimestamp(slot.start);
    if (!startAt) return { error: `${label}.start must be a date-time` };
    const endAt = parseTimestamp(slot.end);
    if (!endAt) return { error: `${label}.end must be a date-time` };
    if (seen.has(slot.id)) return { error: `${label}.id is a duplicate` };
    seen.add(slot.id);
    slots.push({
      id: slot.id,
      provider: slot.provider,
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      startText: slot.start,
      endText: slot.end,
    });
  }
  return { slots };
}

// Undefined means "use the default"; null means invalid.
export function parseLimit(raw) {
  if (raw === undefined) return 10;
  if (typeof raw !== 'string' || !/^\d{1,2}$/.test(raw)) return null;
  const limit = Number(raw);
  return limit >= 1 && limit <= 50 ? limit : null;
}

export function encodeCursor(seq) {
  return Buffer.from(String(seq)).toString('base64url');
}

export function decodeCursor(raw) {
  if (typeof raw !== 'string') return null;
  const seq = Buffer.from(raw, 'base64url').toString();
  // 18 digits always fits in a Postgres bigint.
  if (!/^[1-9]\d{0,17}$/.test(seq) || encodeCursor(seq) !== raw) return null;
  return seq;
}
