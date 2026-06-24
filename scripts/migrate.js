// ==========================================
// ADDITIVE, IDEMPOTENT MIGRATION
// ------------------------------------------
// Safe to run repeatedly and safe against a shared production DB:
// only CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
// Never DROP / ALTER TYPE / rename. Does not touch the `shipments` table,
// so a running production app is unaffected.
//
// Connection: prefers DATABASE_URL (Heroku addon / staging), else PG* vars.
// Usage: node scripts/migrate.js
// ==========================================
require('dotenv').config();
const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : new Pool({
      host: process.env.PGHOST,
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      port: process.env.PGPORT || 5432,
      ssl: { rejectUnauthorized: false }
    });

async function main() {
  console.log('[migrate] Ensuring shipment_documents table...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shipment_documents (
      id          SERIAL PRIMARY KEY,
      shipment_id INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
      doc_type    VARCHAR(50),          -- BL | PIB | SuratJalan | Other
      file_name   VARCHAR(255),
      mime_type   VARCHAR(100),
      file_bytes  BYTEA,                -- default storage (Postgres)
      storage_url TEXT,                 -- used only if switched to S3 later
      uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_shipdoc_shipment ON shipment_documents(shipment_id)');
  console.log('[migrate] Done.');
}

main()
  .catch(err => { console.error('[migrate] FAILED:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
