import pg from 'pg';

let pool;

export function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
    });
    // An idle client losing its connection must not take the process down.
    pool.on('error', (err) => console.error('idle database client error', err));
  }
  return pool;
}

export function query(text, params) {
  return getPool().query(text, params);
}

export async function withTransaction(work) {
  const client = await getPool().connect();
  let failure;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    failure = err;
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    // A client that failed mid-transaction may be broken, so don't reuse it.
    client.release(failure);
  }
}
