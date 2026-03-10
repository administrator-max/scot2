require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// PostgreSQL Database Connection Pool
const pool = new Pool({
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT || 5432, // Fixed: Changed from process.env.PORT to process.env.PGPORT
  ssl: { rejectUnauthorized: false }
});

// GET: Fetch all shipments
app.get('/api/shipments', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM shipments ORDER BY year DESC, id DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST: Add single shipment
app.post('/api/shipments', async (req, res) => {
  try {
    const keys = Object.keys(req.body);
    const values = Object.values(req.body);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    
    const query = `INSERT INTO shipments (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`;
    const result = await pool.query(query, values);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT: Update single shipment
app.put('/api/shipments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const keys = Object.keys(req.body);
    const values = Object.values(req.body);
    
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const query = `UPDATE shipments SET ${setClause} WHERE id = $${keys.length + 1} RETURNING *`;
    
    const result = await pool.query(query, [...values, id]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST: Bulk Upload (Excel integration)
app.post('/api/shipments/bulk', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { updates, inserts } = req.body;

    // Process Updates
    if (updates && updates.length) {
      for (const update of updates) {
        const { id, data } = update;
        const keys = Object.keys(data);
        const values = Object.values(data);
        const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
        const query = `UPDATE shipments SET ${setClause} WHERE id = $${keys.length + 1}`;
        await client.query(query, [...values, id]);
      }
    }

    // Process Inserts
    if (inserts && inserts.length) {
      for (const insert of inserts) {
        const keys = Object.keys(insert);
        const values = Object.values(insert);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        const query = `INSERT INTO shipments (${keys.join(', ')}) VALUES (${placeholders})`;
        await client.query(query, values);
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Bulk operation completed' });
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
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));