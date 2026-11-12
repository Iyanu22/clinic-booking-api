CREATE TABLE IF NOT EXISTS slots (
  id         text PRIMARY KEY,
  provider   text NOT NULL,
  start_at   timestamptz NOT NULL,
  end_at     timestamptz NOT NULL,
  -- The timestamps exactly as they were supplied, so responses echo them unchanged.
  start_text text NOT NULL,
  end_text   text NOT NULL
);

CREATE INDEX IF NOT EXISTS slots_start_idx ON slots (start_at, id);

CREATE TABLE IF NOT EXISTS bookings (
  seq        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id         text NOT NULL UNIQUE,
  slot_id    text NOT NULL REFERENCES slots (id),
  name       text NOT NULL,
  email      text NOT NULL,
  status     text NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- The double-booking guarantee: a slot can hold at most one confirmed booking,
-- however many requests race for it. Cancelled rows don't count, so a cancelled
-- slot can be booked again.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_confirmed_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS bookings_email_seq_idx ON bookings (email, seq);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key_hash     text PRIMARY KEY,
  request_hash text NOT NULL,
  status       integer,
  response     text,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS rate_limit_attempts (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bucket       text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS rate_limit_bucket_idx ON rate_limit_attempts (bucket, attempted_at);
CREATE INDEX IF NOT EXISTS rate_limit_attempted_idx ON rate_limit_attempts (attempted_at);
