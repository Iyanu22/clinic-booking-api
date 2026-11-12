# Clinic booking API

A booking API and patient web page for clinic appointment slots. Node.js, Express and Postgres.

## How the guarantees work

| Requirement | Mechanism |
| --- | --- |
| A slot can't be double-booked | Partial unique index on `bookings (slot_id) WHERE status = 'confirmed'`. The database decides, so it holds across any number of server instances. |
| Retries don't duplicate | The `Idempotency-Key` is claimed in the same transaction as the booking. A concurrent retry blocks on the key's primary key until the first request commits, then replays its stored response. |
| Spam limit | A sliding 60-second window per email, serialised with a Postgres advisory lock so parallel requests can't slip past. Replays of the same request aren't new attempts. A throttled key isn't stored, so it works once the limit clears. |
| Paging | Keyset cursor on an internal sequence, so pages stay correct when bookings change between requests. |

## The web page and the API key

The page must work for patients, who have no API key, and a key embedded in a page isn't secret. So the
page calls a small set of routes under `/web` that run the same code with the key kept on the server.
They allow only listing slots, booking, and viewing a booking by its unguessable id, and bookings there
have an extra limit of 20 attempts per minute per IP address.

## Running locally

Needs Node 24 and a Postgres database.

```sh
npm install
cp .env.example .env   # then fill in DATABASE_URL and API_KEY
npm run db:setup       # creates tables and demo slots
npm start              # http://localhost:3000
```

## Tests

The suite talks to a running server over HTTP, so it works against local or deployed instances.
**It calls `/reset`, which deletes all bookings and slots on the target.**

```sh
BASE_URL=http://localhost:3000 API_KEY=... npm test
```

Set `SLOW=1` to include a test that waits out a real rate-limit window. Afterwards, restore the demo
slots with `npm run db:setup -- --reseed`.

## Deploying

Deployed on Vercel with a Neon database. Set `DATABASE_URL` (Neon's pooled connection string) and
`API_KEY` as Vercel environment variables, run `npm run db:setup` once against the database, then
deploy with `vercel --prod`.
