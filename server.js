require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
}));

// PostgreSQL Database Connection Pool (tuned)
const pool = new Pool({
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT || 5432,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000
});

pool.on('error', err => console.error('[pg pool error]', err));

let hasUpdatedAtColumn = false;

async function refreshColumnCapabilities() {
  const result = await pool.query(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'shipments'
        AND column_name = 'updated_at'
    ) AS exists
  `);
  hasUpdatedAtColumn = Boolean(result.rows[0]?.exists);
}

async function ensureDatabaseShape() {
  try {
    await pool.query('ALTER TABLE shipments ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
    await pool.query('ALTER TABLE shipments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
  } catch (err) {
    console.warn('[db migration warning] Could not ensure timestamp columns:', err.message);
  }

  try {
    await refreshColumnCapabilities();
  } catch (err) {
    hasUpdatedAtColumn = false;
    console.warn('[db warning] Could not inspect shipment columns:', err.message);
  }

  if (!hasUpdatedAtColumn) {
    console.warn('[db warning] shipments.updated_at is unavailable; updates will run without timestamp bumping.');
    return;
  }

  try {
    await pool.query(`
      CREATE OR REPLACE FUNCTION trg_set_updated_at() RETURNS TRIGGER AS $$
      BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await pool.query('DROP TRIGGER IF EXISTS shipments_set_updated_at ON shipments');
    await pool.query(`
      CREATE TRIGGER shipments_set_updated_at
          BEFORE UPDATE ON shipments
          FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at()
    `);
  } catch (err) {
    console.warn('[db migration warning] Could not ensure updated_at trigger:', err.message);
  }
}

function buildUpdateSetClause(keys) {
  const assignments = keys.map((k, i) => `${k} = $${i + 1}`);
  if (hasUpdatedAtColumn) assignments.push('updated_at = NOW()');
  return assignments.join(', ');
}

// Whitelist of writable columns. Anything else from client is silently dropped.
// id/created_at/updated_at are managed by the DB.
const ALLOWED_COLS = new Set([
  'no','cargo_type','consignee','project_name','product','quantity_mt','bl_number',
  'shipping_line','vessel_name','voyage_number','pol','pod','shipment_route','etd','eta',
  'shipment_type','est_sailing_days','actual_sailing_days','pib_billing','bpn','spjm',
  'behandle','sppb','clearance_days','start_unloading','finish_unloading','unloading_days',
  'cargo_status','start_delivery','enter_warehouse','delivery_days','vendor_trucking',
  'warehouse_location','status','remarks','year'
]);

function sanitize(body) {
  const clean = {};
  if (!body || typeof body !== 'object') return clean;
  for (const k of Object.keys(body)) {
    if (ALLOWED_COLS.has(k)) clean[k] = body[k] === '' ? null : body[k];
  }
  return clean;
}

// GET: Fetch all shipments
app.get('/api/shipments', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM shipments ORDER BY year DESC NULLS LAST, id DESC');
    res.set('Cache-Control', 'no-store');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST: Add single shipment
app.post('/api/shipments', async (req, res) => {
  try {
    const data = sanitize(req.body);
    const keys = Object.keys(data);
    if (!keys.length) return res.status(400).json({ error: 'No valid fields provided' });

    const values = keys.map(k => data[k]);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const query = `INSERT INTO shipments (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`;
    const result = await pool.query(query, values);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT: Update single shipment (auto-bumps updated_at)
app.put('/api/shipments/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });

    const data = sanitize(req.body);
    const keys = Object.keys(data);
    if (!keys.length) return res.status(400).json({ error: 'No valid fields provided' });

    const values = keys.map(k => data[k]);
    const setClause = buildUpdateSetClause(keys);
    const query = `UPDATE shipments SET ${setClause} WHERE id = $${keys.length + 1} RETURNING *`;
    const result = await pool.query(query, [...values, id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Shipment not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST: Bulk Upload (Excel integration) — multi-row INSERT, batched UPDATE
app.post('/api/shipments/bulk', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { updates, inserts } = req.body || {};

    let updatedCount = 0, insertedCount = 0;

    // Process Updates (still per-row because column sets vary, but auto-bumps updated_at)
    if (Array.isArray(updates) && updates.length) {
      for (const update of updates) {
        const id = parseInt(update?.id, 10);
        if (!Number.isInteger(id)) continue;
        const data = sanitize(update.data);
        const keys = Object.keys(data);
        if (!keys.length) continue;
        const values = keys.map(k => data[k]);
        const setClause = buildUpdateSetClause(keys);
        const query = `UPDATE shipments SET ${setClause} WHERE id = $${keys.length + 1}`;
        const result = await client.query(query, [...values, id]);
        updatedCount += result.rowCount;
      }
    }

    // Process Inserts as a single multi-row statement per uniform column set
    if (Array.isArray(inserts) && inserts.length) {
      // Group inserts by column-set signature to allow multi-row INSERTs
      const groups = new Map();
      for (const raw of inserts) {
        const data = sanitize(raw);
        const keys = Object.keys(data).sort();
        if (!keys.length) continue;
        const sig = keys.join('|');
        if (!groups.has(sig)) groups.set(sig, { keys, rows: [] });
        groups.get(sig).rows.push(keys.map(k => data[k]));
      }

      for (const { keys, rows } of groups.values()) {
        const params = [];
        const tuples = rows.map((row, rIdx) => {
          const offset = rIdx * keys.length;
          row.forEach(v => params.push(v));
          return '(' + keys.map((_, i) => `$${offset + i + 1}`).join(', ') + ')';
        });
        const query = `INSERT INTO shipments (${keys.join(', ')}) VALUES ${tuples.join(', ')}`;
        await client.query(query, params);
        insertedCount += rows.length;
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, inserted: insertedCount, updated: updatedCount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Express Server Port
const PORT = process.env.PORT || 3000;
ensureDatabaseShape().finally(() => {
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
});
