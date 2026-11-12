// Prints the newest bookings straight from the database. Read-only: it changes nothing.
import { getPool } from '../src/db.js';

const pool = getPool();
const { rows } = await pool.query(`
  SELECT b.name, b.email, b.status, s.provider, s.start_text AS appointment,
         to_char(b.created_at, 'YYYY-MM-DD HH24:MI:SS') AS booked_at, b.id
    FROM bookings b
    JOIN slots s ON s.id = b.slot_id
   ORDER BY b.seq DESC
   LIMIT 20`);

if (rows.length === 0) console.log('No bookings yet.');
else console.table(rows);
await pool.end();
