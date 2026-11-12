// Runs against any deployment: BASE_URL=https://... API_KEY=... npm test
// WARNING: this calls /reset, which wipes the target's bookings and slots.
// Set SLOW=1 to also wait out a real rate-limit window (about a minute).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { beforeEach, describe, test } from 'node:test';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const KEY = process.env.API_KEY;
assert.ok(KEY, 'API_KEY must be set');

const hours = (n) => new Date(Date.now() + n * 3_600_000).toISOString();
const uniqueEmail = () => `user-${crypto.randomUUID()}@example.com`;

const call = async (method, path, { body, headers = {}, key = KEY, raw } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(key ? { 'X-API-Key': key } : {}),
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, body: json, headers: res.headers };
};

const book = (slot_id, email = uniqueEmail(), headers, name = 'Ada Obi') =>
  call('POST', '/bookings', { body: { slot_id, name, email }, headers });

const SLOTS = [
  { id: 's3', provider: 'Dr Ade', start: '2099-12-10T11:00:00Z', end: '2099-12-10T11:30:00Z' },
  { id: 's1', provider: 'Dr Ade', start: '2099-12-10T09:00:00Z', end: '2099-12-10T09:30:00Z' },
  { id: 's2', provider: 'Dr Bello', start: '2099-12-10T10:00:00Z', end: '2099-12-10T10:30:00Z' },
  { id: 'past', provider: 'Dr Bello', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' },
  { id: 'soon', provider: 'Dr Bello', start: hours(1), end: hours(2) },
];

beforeEach(async () => {
  const res = await call('POST', '/reset', { body: { slots: SLOTS } });
  assert.equal(res.status, 200);
});

describe('level 1', () => {
  test('lists slots earliest first, with availability and original timestamps', async () => {
    const res = await call('GET', '/slots');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.slots.map((s) => s.id).slice(0, 1), ['past']);
    const s1 = res.body.slots.find((s) => s.id === 's1');
    assert.deepEqual(s1, { ...SLOTS[1], available: true });
    const times = res.body.slots.map((s) => Date.parse(s.start));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });

  test('filters by exact provider', async () => {
    const res = await call('GET', '/slots?provider=Dr%20Ade');
    assert.deepEqual(res.body.slots.map((s) => s.id), ['s1', 's3']);
    const partial = await call('GET', '/slots?provider=Dr');
    assert.deepEqual(partial.body.slots, []);
  });

  test('books a slot, looks it up, and marks the slot unavailable', async () => {
    const created = await book('s1', 'ada@example.com');
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'confirmed');
    assert.equal(created.body.slot_id, 's1');
    assert.ok(created.body.id);
    assert.ok(!Number.isNaN(Date.parse(created.body.created_at)));

    const found = await call('GET', `/bookings/${created.body.id}`);
    assert.equal(found.status, 200);
    assert.deepEqual(found.body, created.body);

    const slots = await call('GET', '/slots');
    assert.equal(slots.body.slots.find((s) => s.id === 's1').available, false);
  });

  test('unknown booking id is 404 with an error body', async () => {
    const res = await call('GET', '/bookings/not-a-real-id');
    assert.equal(res.status, 404);
    assert.equal(typeof res.body.error, 'string');
  });

  test('reset clears bookings and replaces slots', async () => {
    const created = await book('s1');
    await call('POST', '/reset', { body: { slots: [SLOTS[0]] } });
    assert.equal((await call('GET', `/bookings/${created.body.id}`)).status, 404);
    assert.deepEqual((await call('GET', '/slots')).body.slots.map((s) => s.id), ['s3']);
  });
});

describe('level 2', () => {
  for (const [label, key] of [['missing', null], ['wrong', 'nope']]) {
    test(`${label} API key is 401 on every endpoint`, async () => {
      const endpoints = [
        ['GET', '/slots'], ['POST', '/bookings'], ['GET', '/bookings?email=a@b.co'],
        ['GET', '/bookings/x'], ['DELETE', '/bookings/x'], ['POST', '/reset'], ['GET', '/nothing'],
      ];
      for (const [method, path] of endpoints) {
        const res = await call(method, path, { key });
        assert.equal(res.status, 401, `${method} ${path}`);
        assert.equal(typeof res.body.error, 'string');
      }
    });
  }

  const invalid = {
    'missing slot_id': { name: 'A', email: 'a@example.com' },
    'empty slot_id': { slot_id: '', name: 'A', email: 'a@example.com' },
    'missing name': { slot_id: 's1', email: 'a@example.com' },
    'blank name': { slot_id: 's1', name: '   ', email: 'a@example.com' },
    'missing email': { slot_id: 's1', name: 'A' },
    'blank email': { slot_id: 's1', name: 'A', email: '  ' },
    'number name': { slot_id: 's1', name: 5, email: 'a@example.com' },
    'null byte in name': { slot_id: 's1', name: 'A\u0000B', email: 'a@example.com' },
  };
  for (const [label, body] of Object.entries(invalid)) {
    test(`400 for ${label}`, async () => {
      const res = await call('POST', '/bookings', { body: { ...body, email: body.email === 'a@example.com' ? uniqueEmail() : body.email } });
      assert.equal(res.status, 400);
      assert.equal(typeof res.body.error, 'string');
    });
  }

  for (const email of ['not-an-email', 'a@', '@b.com', 'a b@c.com', 'a@b', 'a@@b.com', 'a@b..com', 'a@b.com.']) {
    test(`400 for invalid email ${email}`, async () => {
      assert.equal((await book('s1', email)).status, 400);
    });
  }

  test('400 for malformed JSON and non-object bodies', async () => {
    assert.equal((await call('POST', '/bookings', { raw: '{nope' })).status, 400);
    assert.equal((await call('POST', '/bookings', { raw: '[1,2]' })).status, 400);
    assert.equal((await call('POST', '/bookings', { key: KEY })).status, 400);
  });

  test('404 for an unknown slot', async () => {
    assert.equal((await book('missing')).status, 404);
  });

  test('400 for a slot that has already started', async () => {
    assert.equal((await book('past')).status, 400);
  });

  test('trims name and email and lower-cases email', async () => {
    const res = await call('POST', '/bookings', {
      body: { slot_id: 's1', name: '  Ada Obi ', email: '  ADA@Example.COM ' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Ada Obi');
    assert.equal(res.body.email, 'ada@example.com');
  });
});

describe('level 3', () => {
  test('second booking on a taken slot is 409', async () => {
    assert.equal((await book('s1')).status, 201);
    const res = await book('s1');
    assert.equal(res.status, 409);
    assert.equal(typeof res.body.error, 'string');
  });

  test('50 simultaneous requests produce exactly one booking', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => book('s1')));
    const counts = Object.groupBy(results, (r) => r.status);
    assert.deepEqual(Object.keys(counts).sort(), ['201', '409'], JSON.stringify(results.map((r) => r.status)));
    assert.equal(counts[201].length, 1);
    assert.equal(counts[409].length, 49);
  });

  test('cancel frees the slot; cancelling twice is 409; unknown is 404', async () => {
    const created = await book('s1');
    const cancelled = await call('DELETE', `/bookings/${created.body.id}`);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, 'cancelled');
    assert.equal(cancelled.body.id, created.body.id);

    assert.equal((await call('GET', `/bookings/${created.body.id}`)).body.status, 'cancelled');
    const slots = await call('GET', '/slots');
    assert.equal(slots.body.slots.find((s) => s.id === 's1').available, true);

    assert.equal((await call('DELETE', `/bookings/${created.body.id}`)).status, 409);
    assert.equal((await call('DELETE', '/bookings/unknown')).status, 404);
    assert.equal((await book('s1')).status, 201);
  });

  test('simultaneous cancels: exactly one succeeds', async () => {
    const created = await book('s1');
    const results = await Promise.all(Array.from({ length: 10 }, () => call('DELETE', `/bookings/${created.body.id}`)));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 9);
  });
});

describe('level 4', () => {
  const idem = (key) => ({ 'Idempotency-Key': key });

  test('replay returns the same response and creates nothing', async () => {
    const email = uniqueEmail();
    const key = crypto.randomUUID();
    const first = await book('s1', email, idem(key));
    const second = await book('s1', email, idem(key));
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.deepEqual(second.body, first.body);
    assert.equal((await call('GET', `/bookings?email=${email}`)).body.bookings.length, 1);
  });

  test('simultaneous requests with one key give one booking and all succeed', async () => {
    const email = uniqueEmail();
    const key = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 30 }, () => book('s1', email, idem(key))));
    assert.deepEqual([...new Set(results.map((r) => r.status))], [201]);
    assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
    assert.equal((await call('GET', `/bookings?email=${email}`)).body.bookings.length, 1);
  });

  test('same key with a different body is 422', async () => {
    const key = crypto.randomUUID();
    assert.equal((await book('s1', uniqueEmail(), idem(key))).status, 201);
    const res = await book('s2', uniqueEmail(), idem(key));
    assert.equal(res.status, 422);
    assert.equal(typeof res.body.error, 'string');
  });

  test('key order in the body does not matter', async () => {
    const key = crypto.randomUUID();
    const email = uniqueEmail();
    const a = await call('POST', '/bookings', { raw: JSON.stringify({ slot_id: 's1', name: 'A', email }), headers: idem(key) });
    const b = await call('POST', '/bookings', { raw: JSON.stringify({ email, name: 'A', slot_id: 's1' }), headers: idem(key) });
    assert.equal(b.status, 201);
    assert.equal(b.body.id, a.body.id);
  });

  test('failed responses replay too, and survive state changes', async () => {
    const holder = await book('s1');
    const key = crypto.randomUUID();
    const email = uniqueEmail();
    assert.equal((await book('s1', email, idem(key))).status, 409);
    await call('DELETE', `/bookings/${holder.body.id}`);
    assert.equal((await book('s1', email, idem(key))).status, 409);
  });

  test('replay after cancelling returns the original response', async () => {
    const key = crypto.randomUUID();
    const email = uniqueEmail();
    const first = await book('s1', email, idem(key));
    await call('DELETE', `/bookings/${first.body.id}`);
    const replay = await book('s1', email, idem(key));
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body, first.body);
  });

  test('pages through bookings oldest first, case-insensitively', async () => {
    const email = uniqueEmail();
    const ids = [];
    for (const slot of ['s1', 's2', 's3']) ids.push((await book(slot, email)).body.id);
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const query = `/bookings?email=${email.toUpperCase()}&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await call('GET', query);
      assert.equal(res.status, 200);
      seen.push(...res.body.bookings.map((b) => b.id));
      cursor = res.body.next_cursor;
      pages += 1;
    } while (cursor);
    assert.deepEqual(seen, ids);
    assert.equal(pages, 2);
  });

  test('exact page boundary ends with next_cursor null', async () => {
    const email = uniqueEmail();
    await book('s1', email);
    await book('s2', email);
    const res = await call('GET', `/bookings?email=${email}&limit=2`);
    assert.equal(res.body.bookings.length, 2);
    assert.equal(res.body.next_cursor, null);
  });

  test('cursor is stable when a listed booking is cancelled between pages', async () => {
    const email = uniqueEmail();
    const a = await book('s1', email);
    const b = await book('s2', email);
    const c = await book('s3', email);
    const first = await call('GET', `/bookings?email=${email}&limit=1`);
    await call('DELETE', `/bookings/${a.body.id}`);
    const second = await call('GET', `/bookings?email=${email}&limit=5&cursor=${first.body.next_cursor}`);
    assert.deepEqual(second.body.bookings.map((x) => x.id), [b.body.id, c.body.id]);
  });

  for (const limit of ['0', '51', '-1', 'abc', '1.5', '']) {
    test(`limit=${limit || '(empty)'} is 400`, async () => {
      const res = await call('GET', `/bookings?email=a@example.com&limit=${limit}`);
      assert.equal(res.status, 400);
      assert.equal(typeof res.body.error, 'string');
    });
  }

  test('limit 1 and 50 are accepted', async () => {
    assert.equal((await call('GET', '/bookings?email=a@example.com&limit=1')).status, 200);
    assert.equal((await call('GET', '/bookings?email=a@example.com&limit=50')).status, 200);
  });

  test('bad cursor and missing email are 400', async () => {
    assert.equal((await call('GET', '/bookings?email=a@example.com&cursor=@@@')).status, 400);
    assert.equal((await call('GET', '/bookings')).status, 400);
  });
});

describe('level 5', () => {
  test('sixth attempt is 429 with a whole-second Retry-After; others unaffected', async () => {
    const email = uniqueEmail();
    assert.equal((await book('s1', email)).status, 201);
    assert.equal((await book('s1', email)).status, 409);
    assert.equal((await book('missing', email)).status, 404);
    assert.equal((await book('past', email)).status, 400);
    assert.equal((await call('POST', '/bookings', { body: { slot_id: 's2', email } })).status, 400);

    const limited = await book('s2', email);
    assert.equal(limited.status, 429);
    assert.equal(typeof limited.body.error, 'string');
    assert.match(limited.headers.get('retry-after'), /^[1-9]\d*$/);
    assert.ok(Number(limited.headers.get('retry-after')) <= 60);

    assert.equal((await book('s2', uniqueEmail())).status, 201);
  });

  test('the limit ignores email case and spacing', async () => {
    const email = uniqueEmail();
    for (const variant of [email, email.toUpperCase(), ` ${email} `, email, email]) {
      assert.equal((await book('missing', variant)).status, 404);
    }
    assert.equal((await book('missing', email.toUpperCase())).status, 429);
  });

  test('simultaneous attempts cannot get past the limit', async () => {
    const email = uniqueEmail();
    const results = await Promise.all(Array.from({ length: 20 }, () => book('missing', email)));
    assert.equal(results.filter((r) => r.status === 404).length, 5);
    assert.equal(results.filter((r) => r.status === 429).length, 15);
  });

  test('idempotent replays do not use up attempts', async () => {
    const email = uniqueEmail();
    const headers = { 'Idempotency-Key': crypto.randomUUID() };
    for (let i = 0; i < 10; i += 1) assert.equal((await book('s1', email, headers)).status, 201);
  });

  test('a throttled key is not stored, so it can be used after the limit clears', { skip: !process.env.SLOW }, async () => {
    const email = uniqueEmail();
    for (let i = 0; i < 5; i += 1) await book('missing', email);
    const headers = { 'Idempotency-Key': crypto.randomUUID() };
    const limited = await book('s1', email, headers);
    assert.equal(limited.status, 429);
    await new Promise((resolve) => setTimeout(resolve, Number(limited.headers.get('retry-after')) * 1000 + 200));
    assert.equal((await book('s1', email, headers)).status, 201);
  });
});

describe('web page routes', () => {
  test('page is public and does not contain the API key', async () => {
    const res = await fetch(`${BASE}/`);
    assert.equal(res.status, 200);
    assert.ok(!(await res.text()).includes(KEY));
  });

  test('page can list, book and confirm without a key, but not reset', async () => {
    assert.equal((await call('GET', '/web/slots', { key: null })).status, 200);
    const created = await call('POST', '/web/bookings', {
      key: null,
      body: { slot_id: 's1', name: 'Ada', email: uniqueEmail() },
    });
    assert.equal(created.status, 201);
    assert.equal((await call('GET', `/web/bookings/${created.body.id}`, { key: null })).status, 200);
    assert.equal((await call('POST', '/web/reset', { key: null, body: { slots: [] } })).status, 401);
    assert.equal((await call('DELETE', `/web/bookings/${created.body.id}`, { key: null })).status, 401);
  });
});
