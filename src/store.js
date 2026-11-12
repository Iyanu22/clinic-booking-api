import crypto from 'node:crypto';
import { query, withTransaction } from './db.js';
import {
  decodeCursor,
  encodeCursor,
  normalizeEmail,
  parseLimit,
  validateNewBooking,
  validateSlots,
} from './validation.js';

const EMAIL_ATTEMPTS_PER_MINUTE = 5;
const WEB_ATTEMPTS_PER_MINUTE = 20;
const IDEMPOTENCY_CLAIM_RETRIES = 5;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const failure = (status, error, extra) => ({ status, body: { error }, ...extra });

function toBooking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: row.created_at.toISOString(),
  };
}

// Key order must not make two otherwise identical bodies look different.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Sliding-window limiter. The advisory lock serialises attempts on one bucket until
 * the transaction ends, so a burst of parallel requests can't all read a low count.
 * Returns a 429 result when the bucket is full, otherwise records the attempt and
 * returns null.
 */
async function consumeAttempt(client, bucket, limit) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [bucket]);

  const { rows } = await client.query(
    `SELECT count(*)::int AS used,
            ceil(extract(epoch FROM min(attempted_at) + interval '60 seconds' - clock_timestamp()))::int AS wait
       FROM rate_limit_attempts
      WHERE bucket = $1 AND attempted_at > clock_timestamp() - interval '60 seconds'`,
    [bucket],
  );
  if (rows[0].used >= limit) {
    return failure(429, 'too many attempts, try again later', {
      retryAfter: Math.max(1, rows[0].wait),
    });
  }

  await client.query('INSERT INTO rate_limit_attempts (bucket) VALUES ($1)', [bucket]);

  // Expired rows are never read again; sweep a few now and then so the table stays small.
  if (Math.random() < 0.05) {
    await client.query(
      `DELETE FROM rate_limit_attempts
        WHERE id IN (SELECT id FROM rate_limit_attempts
                      WHERE attempted_at < clock_timestamp() - interval '60 seconds'
                      LIMIT 100 FOR UPDATE SKIP LOCKED)`,
    );
  }
  return null;
}

function consumeEmailAttempt(client, body) {
  if (typeof body.email !== 'string' || body.email.trim() === '') return null;
  const bucket = `email:${sha256(normalizeEmail(body.email))}`;
  return consumeAttempt(client, bucket, EMAIL_ATTEMPTS_PER_MINUTE);
}

async function placeBooking(client, body) {
  const { error, booking } = validateNewBooking(body);
  if (error) return failure(400, error);

  const slot = await client.query(
    'SELECT start_at <= clock_timestamp() AS started FROM slots WHERE id = $1',
    [booking.slotId],
  );
  if (slot.rowCount === 0) return failure(404, 'slot not found');
  if (slot.rows[0].started) return failure(400, 'slot has already started');

  // A racing insert for the same slot blocks here on the partial unique index until
  // the other transaction ends, then does nothing if that one committed.
  const inserted = await client.query(
    `INSERT INTO bookings (id, slot_id, name, email, status)
     VALUES ($1, $2, $3, $4, 'confirmed')
     ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
     RETURNING id, slot_id, name, email, status, created_at`,
    [crypto.randomUUID(), booking.slotId, booking.name, booking.email],
  );
  if (inserted.rowCount === 0) return failure(409, 'slot already booked');
  return { status: 201, body: toBooking(inserted.rows[0]) };
}

/**
 * One idempotent attempt, inside a transaction. Claiming the key first means a
 * concurrent request with the same key blocks on the primary key until this
 * transaction commits, then replays the stored response.
 *
 * Returns null when the claim holder gave the key back, so the caller should retry.
 */
async function bookWithKey(client, body, idempotencyKey) {
  const keyHash = sha256(idempotencyKey);
  const requestHash = sha256(canonicalJson(body));

  const claim = await client.query(
    `INSERT INTO idempotency_keys (key_hash, request_hash)
     VALUES ($1, $2) ON CONFLICT (key_hash) DO NOTHING RETURNING key_hash`,
    [keyHash, requestHash],
  );

  if (claim.rowCount === 0) {
    const { rows } = await client.query(
      'SELECT request_hash, status, response FROM idempotency_keys WHERE key_hash = $1',
      [keyHash],
    );
    if (rows.length === 0) return null;

    // A replay is the same attempt again, so it doesn't count against the limit.
    // A different body under a used key is a new (failed) attempt, so it does.
    if (rows[0].request_hash === requestHash) {
      return { status: rows[0].status, body: JSON.parse(rows[0].response) };
    }
    return (
      (await consumeEmailAttempt(client, body)) ??
      failure(422, 'Idempotency-Key was already used with a different body')
    );
  }

  const limited = await consumeEmailAttempt(client, body);
  if (limited) {
    // Being throttled is temporary: free the key so a later retry can go through.
    await client.query('DELETE FROM idempotency_keys WHERE key_hash = $1', [keyHash]);
    return limited;
  }

  const result = await placeBooking(client, body);
  await client.query(
    'UPDATE idempotency_keys SET status = $2, response = $3 WHERE key_hash = $1',
    [keyHash, result.status, JSON.stringify(result.body)],
  );
  return result;
}

export async function createBooking(body, idempotencyKey) {
  if (!idempotencyKey) {
    return withTransaction(
      async (client) => (await consumeEmailAttempt(client, body)) ?? placeBooking(client, body),
    );
  }

  for (let attempt = 0; attempt < IDEMPOTENCY_CLAIM_RETRIES; attempt += 1) {
    const result = await withTransaction((client) => bookWithKey(client, body, idempotencyKey));
    if (result) return result;
  }
  throw new Error('could not claim idempotency key');
}

// Extra limit for the public web page, which has no API key to gate it.
export function consumeWebAttempt(ip) {
  return withTransaction((client) => consumeAttempt(client, `ip:${ip}`, WEB_ATTEMPTS_PER_MINUTE));
}

export async function listSlots(provider) {
  if (provider?.includes('\0')) return [];
  const filtered = provider !== undefined;
  const { rows } = await query(
    `SELECT s.id, s.provider, s.start_text, s.end_text,
            NOT EXISTS (SELECT 1 FROM bookings b
                         WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
       FROM slots s
      ${filtered ? 'WHERE s.provider = $1' : ''}
      ORDER BY s.start_at, s.id`,
    filtered ? [provider] : [],
  );
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    start: row.start_text,
    end: row.end_text,
    available: row.available,
  }));
}

export async function getBooking(id) {
  if (id.includes('\0')) return null;
  const { rows } = await query(
    'SELECT id, slot_id, name, email, status, created_at FROM bookings WHERE id = $1',
    [id],
  );
  return rows[0] ? toBooking(rows[0]) : null;
}

export async function cancelBooking(id) {
  if (id.includes('\0')) return failure(404, 'booking not found');

  const updated = await query(
    `UPDATE bookings SET status = 'cancelled'
      WHERE id = $1 AND status = 'confirmed'
      RETURNING id, slot_id, name, email, status, created_at`,
    [id],
  );
  if (updated.rowCount === 1) return { status: 200, body: toBooking(updated.rows[0]) };

  const existing = await query('SELECT 1 FROM bookings WHERE id = $1', [id]);
  return existing.rowCount === 0
    ? failure(404, 'booking not found')
    : failure(409, 'booking already cancelled');
}

export async function listBookings({ email, limit: rawLimit, cursor: rawCursor }) {
  if (typeof email !== 'string' || email.trim() === '') return failure(400, 'email is required');

  const limit = parseLimit(rawLimit);
  if (limit === null) return failure(400, 'limit must be an integer from 1 to 50');

  let afterSeq = '0';
  if (rawCursor !== undefined) {
    afterSeq = decodeCursor(rawCursor);
    if (afterSeq === null) return failure(400, 'cursor is invalid');
  }

  if (email.includes('\0')) return { status: 200, body: { bookings: [], next_cursor: null } };

  // Keyset paging on seq stays correct when bookings are added or cancelled between pages.
  // One extra row tells us whether another page exists.
  const { rows } = await query(
    `SELECT seq, id, slot_id, name, email, status, created_at
       FROM bookings WHERE email = $1 AND seq > $2
      ORDER BY seq LIMIT $3`,
    [normalizeEmail(email), afterSeq, limit + 1],
  );
  const page = rows.slice(0, limit);
  return {
    status: 200,
    body: {
      bookings: page.map(toBooking),
      next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1].seq) : null,
    },
  };
}

export async function resetAll(body) {
  const { error, slots } = validateSlots(body);
  if (error) return failure(400, error);

  await withTransaction(async (client) => {
    // Listed in the order a booking touches these tables, so the two can't deadlock.
    await client.query('TRUNCATE idempotency_keys, rate_limit_attempts, slots, bookings');
    await client.query(
      `INSERT INTO slots (id, provider, start_at, end_at, start_text, end_text)
       SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[], $5::text[], $6::text[])`,
      [
        slots.map((slot) => slot.id),
        slots.map((slot) => slot.provider),
        slots.map((slot) => slot.startAt),
        slots.map((slot) => slot.endAt),
        slots.map((slot) => slot.startText),
        slots.map((slot) => slot.endText),
      ],
    );
  });
  return { status: 200, body: { ok: true, slots: slots.length } };
}
