const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('[db] WARNING: DATABASE_URL is not set. Database calls will fail.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon (like most managed Postgres providers) requires SSL, but the cert
  // chain isn't always verifiable in local dev, so we relax verification here.
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('[db] Unexpected error on idle Postgres client:', err);
});

module.exports = pool;
