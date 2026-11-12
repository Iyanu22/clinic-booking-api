import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import * as store from './store.js';
import { isPlainObject } from './validation.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const digest = (value) => crypto.createHash('sha256').update(value).digest();

// Accept JSON whatever Content-Type the caller sent.
const parseJson = express.json({ type: () => true, strict: false });

function send(res, { status, body, retryAfter }) {
  if (retryAfter) res.set('Retry-After', String(retryAfter));
  res.status(status).json(body);
}

function requireApiKey(req, res, next) {
  const expected = process.env.API_KEY;
  if (!expected) throw new Error('API_KEY is not configured');
  const given = req.get('X-API-Key') ?? '';
  if (!crypto.timingSafeEqual(digest(given), digest(expected))) {
    res.status(401).json({ error: 'missing or invalid API key' });
    return;
  }
  next();
}

async function getSlots(req, res) {
  const { provider } = req.query;
  if (provider !== undefined && typeof provider !== 'string') {
    res.status(400).json({ error: 'provider must be a single value' });
    return;
  }
  res.json({ slots: await store.listSlots(provider) });
}

async function postBooking(req, res) {
  const body = req.body ?? {};
  if (!isPlainObject(body)) {
    res.status(400).json({ error: 'request body must be a JSON object' });
    return;
  }
  send(res, await store.createBooking(body, req.get('Idempotency-Key')));
}

async function getBooking(req, res) {
  const booking = await store.getBooking(req.params.id);
  if (!booking) {
    res.status(404).json({ error: 'booking not found' });
    return;
  }
  res.json(booking);
}

function clientIp(req) {
  // Vercel sets x-real-ip itself; callers can't forge it there.
  const ip = process.env.VERCEL ? req.get('x-real-ip') : req.socket.remoteAddress;
  return ip ?? 'unknown';
}

async function limitWebBookings(req, res, next) {
  const limited = await store.consumeWebAttempt(clientIp(req));
  if (limited) {
    send(res, limited);
    return;
  }
  next();
}

// Routes for the patient web page. The API key stays on the server, so these expose
// only what a patient needs: no reset, no cancelling, no listing someone's bookings.
const web = express.Router();
web.get('/slots', getSlots);
web.post('/bookings', limitWebBookings, parseJson, postBooking);
web.get('/bookings/:id', getBooking);

const api = express.Router();
api.use(requireApiKey);
api.post('/reset', parseJson, async (req, res) => send(res, await store.resetAll(req.body)));
api.get('/slots', getSlots);
api.post('/bookings', parseJson, postBooking);
api.get('/bookings', async (req, res) => send(res, await store.listBookings(req.query)));
api.get('/bookings/:id', getBooking);
api.delete('/bookings/:id', async (req, res) => send(res, await store.cancelBooking(req.params.id)));

const app = express();
app.disable('x-powered-by');
app.use(express.static(publicDir));
app.use('/web', web);
app.use(api);

app.use((req, res) => {
  res.status(404).json({ error: 'not found' });
});

// Express requires all four arguments to treat this as the error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'request body must be valid JSON' });
    return;
  }
  const status = err.status ?? err.statusCode ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'internal server error' : err.message });
});

export default app;
