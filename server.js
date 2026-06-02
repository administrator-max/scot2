require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const multer = require('multer');
const ocr = require('./lib/ocr');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Uploads are held in memory and streamed straight into Postgres (BYTEA) — the
// Heroku dyno filesystem is ephemeral, so nothing persistent touches disk.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const ALLOWED_DOC_MIME = /^(application\/pdf|image\/(png|jpe?g|webp|tiff?))$/i;
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

// PostgreSQL Database Connection Pool (tuned).
// Prefer DATABASE_URL when present (Heroku Postgres addon / staging); otherwise
// fall back to discrete PG* vars (production). Production has no DATABASE_URL,
// so its connection behavior is unchanged.
const poolTuning = {
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000
};
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, ...poolTuning })
  : new Pool({
      host: process.env.PGHOST,
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      port: process.env.PGPORT || 5432,
      ssl: { rejectUnauthorized: false },
      ...poolTuning
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

  // Document attachments (additive, idempotent — does not touch `shipments`).
  // Mirrors scripts/migrate.js so a fresh staging DB self-heals on boot.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shipment_documents (
        id          SERIAL PRIMARY KEY,
        shipment_id INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
        doc_type    VARCHAR(50),
        file_name   VARCHAR(255),
        mime_type   VARCHAR(100),
        file_bytes  BYTEA,
        storage_url TEXT,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_shipdoc_shipment ON shipment_documents(shipment_id)');
  } catch (err) {
    console.warn('[db migration warning] Could not ensure shipment_documents table:', err.message);
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

function isHttpUrl(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === 'http:' || x.protocol === 'https:';
  } catch (_) {
    return false;
  }
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

// POST: OCR a document and return pre-filled fields (does NOT write to DB).
// Human-in-the-loop: the client reviews/corrects before saving via /api/shipments.
app.post('/api/ocr', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!ALLOWED_DOC_MIME.test(req.file.mimetype) && !/\.pdf$/i.test(req.file.originalname || '')) {
      return res.status(400).json({ error: 'Unsupported file type (PDF or image only)' });
    }
    const { text, method } = await ocr.extractText(req.file.buffer, req.file.mimetype, req.file.originalname);
    const parsed = await ocr.parseFields(text);
    res.set('Cache-Control', 'no-store');
    res.json({
      method,                       // 'text-layer' | 'ocr'
      source: parsed.source,        // 'llm' | 'regex' | 'empty'
      fields: parsed.fields,
      confidence: parsed.confidence,
      textPreview: (text || '').slice(0, 2000)
    });
  } catch (err) {
    console.error('[ocr]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST: attach a document LINK (e.g. Google Drive URL) to a shipment.
// Stores only the URL in `storage_url` — no file bytes, no storage burden.
app.post('/api/shipments/:id/documents', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const { storage_url, doc_type, file_name } = req.body || {};
    if (!isHttpUrl(storage_url)) {
      return res.status(400).json({ error: 'A valid http(s) link is required' });
    }
    const docType = typeof doc_type === 'string' && doc_type ? doc_type.slice(0, 50) : null;
    const label = typeof file_name === 'string' && file_name ? file_name.slice(0, 255) : null;
    const result = await pool.query(
      `INSERT INTO shipment_documents (shipment_id, doc_type, file_name, storage_url)
       VALUES ($1, $2, $3, $4)
       RETURNING id, shipment_id, doc_type, file_name, storage_url, uploaded_at`,
      [id, docType, label, String(storage_url)]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET: list document links for a shipment.
app.get('/api/shipments/:id/documents', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const result = await pool.query(
      `SELECT id, shipment_id, doc_type, file_name, storage_url, uploaded_at
       FROM shipment_documents
       WHERE shipment_id = $1
       ORDER BY uploaded_at DESC, id DESC`,
      [id]
    );
    res.set('Cache-Control', 'no-store');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE: remove a document link.
app.delete('/api/documents/:docId', async (req, res) => {
  try {
    const docId = parseInt(req.params.docId, 10);
    if (!Number.isInteger(docId)) return res.status(400).json({ error: 'Invalid id' });
    const result = await pool.query('DELETE FROM shipment_documents WHERE id = $1', [docId]);
    if (!result.rowCount) return res.status(404).json({ error: 'Document not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET: resolve a document — redirects to its stored link.
app.get('/api/documents/:docId', async (req, res) => {
  try {
    const docId = parseInt(req.params.docId, 10);
    if (!Number.isInteger(docId)) return res.status(400).json({ error: 'Invalid id' });
    const result = await pool.query('SELECT storage_url FROM shipment_documents WHERE id = $1', [docId]);
    if (!result.rows.length || !result.rows[0].storage_url) {
      return res.status(404).json({ error: 'Document not found' });
    }
    res.redirect(result.rows[0].storage_url);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Express Server Port
const PORT = process.env.PORT || 3000;
ensureDatabaseShape().finally(() => {
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
});
