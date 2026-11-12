// Creates the tables, and adds demo slots if there are none.
// Pass --reseed to wipe all bookings and start again from fresh demo slots.
import { readFile } from 'node:fs/promises';
import { getPool } from '../src/db.js';
import { resetAll } from '../src/store.js';

const PROVIDERS = [
  { name: 'Dr Ade', times: ['09:00', '09:30', '10:00', '10:30'] },
  { name: 'Dr Bello', times: ['11:00', '11:30', '14:00', '14:30'] },
  { name: 'Dr Chukwu', times: ['13:00', '13:30', '15:00', '15:30'] },
];
const WEEKS = 12;

function demoSlots() {
  const slots = [];
  const today = new Date();
  for (let offset = 1; offset <= WEEKS * 7; offset += 1) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset));
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    const date = day.toISOString().slice(0, 10);
    for (const { name, times } of PROVIDERS) {
      for (const time of times) {
        const start = new Date(`${date}T${time}:00Z`);
        const end = new Date(start.getTime() + 30 * 60 * 1000);
        slots.push({
          id: `s${slots.length + 1}`,
          provider: name,
          start: start.toISOString().replace('.000Z', 'Z'),
          end: end.toISOString().replace('.000Z', 'Z'),
        });
      }
    }
  }
  return slots;
}

const pool = getPool();
await pool.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
console.log('Schema is up to date.');

const { rows } = await pool.query('SELECT count(*)::int AS count FROM slots');
if (rows[0].count === 0 || process.argv.includes('--reseed')) {
  const result = await resetAll({ slots: demoSlots() });
  console.log(`Seeded ${result.body.slots} demo slots.`);
} else {
  console.log(`Left the existing ${rows[0].count} slots alone.`);
}
await pool.end();
