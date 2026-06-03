// ==========================================
// OCR / DOCUMENT FIELD EXTRACTION
// ------------------------------------------
// Strategy:
//   1. PDF with a text layer (PIB, Surat Jalan)  -> pdftotext (fast, accurate)
//   2. Scanned PDF / image (Ocean B/L)           -> pdftoppm rasterize + tesseract
//   3. Raw text -> structured shipment fields:
//        - Claude API when ANTHROPIC_API_KEY is set (robust across layouts)
//        - regex fallback otherwise (brittle, fixed-format docs only)
// Temp files live in os.tmpdir() and are always cleaned up. Persistent storage
// of the uploaded file is handled separately (Postgres BYTEA), not here.
// ==========================================
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TEXT_MAX_PAGES = 10;                                    // pdftotext is fast — scan more pages
const OCR_MAX_PAGES = Number(process.env.OCR_MAX_PAGES) || 3; // tesseract is slow (~25-30s/page);
                                                             // async job model lifts the 30s cap, so a few front pages is fine
const TEXT_LAYER_MIN_CHARS = 120;    // below this, treat the PDF as a scan
const MAX_TEXT_CHARS = 12000;        // cap what we send to the LLM

// Only these map onto shipments columns (server still re-whitelists via sanitize()).
const FIELD_KEYS = [
  'cargo_type', 'consignee', 'project_name', 'product', 'quantity_mt', 'bl_number',
  'shipping_line', 'vessel_name', 'voyage_number', 'pol', 'pod', 'shipment_route',
  'etd', 'eta', 'shipment_type', 'vendor_trucking', 'warehouse_location',
  'pib_billing', 'remarks', 'year'
];

function tmpFile(ext) {
  return path.join(os.tmpdir(), `scot-ocr-${crypto.randomBytes(8).toString('hex')}${ext || ''}`);
}

async function ocrImage(imgPath) {
  try {
    const { stdout } = await execFileP('tesseract', [imgPath, 'stdout', '--psm', '6', '-l', 'eng'], {
      timeout: 90000,
      // OMP_THREAD_LIMIT=1 avoids the OpenMP hang seen on small dynos.
      env: { ...process.env, OMP_THREAD_LIMIT: process.env.OMP_THREAD_LIMIT || '1' },
      maxBuffer: 16 * 1024 * 1024
    });
    return stdout || '';
  } catch (e) {
    console.warn('[ocr] tesseract failed:', e.message);
    return '';
  }
}

async function extractTextFromPdf(pdfPath) {
  // 1) Try the embedded text layer first.
  const txtPath = tmpFile('.txt');
  try {
    await execFileP('pdftotext', ['-layout', '-f', '1', '-l', String(TEXT_MAX_PAGES), pdfPath, txtPath], { timeout: 30000 });
    const text = await fsp.readFile(txtPath, 'utf8').catch(() => '');
    if (text.replace(/\s+/g, '').length >= TEXT_LAYER_MIN_CHARS) {
      return { text, method: 'text-layer' };
    }
  } catch (e) {
    // pdftotext missing/failed — fall through to OCR.
  } finally {
    fsp.unlink(txtPath).catch(() => {});
  }

  // 2) Rasterize and OCR each page.
  const prefix = tmpFile('');
  const created = [];
  try {
    await execFileP('pdftoppm', ['-png', '-r', '200', '-f', '1', '-l', String(OCR_MAX_PAGES), pdfPath, prefix], { timeout: 180000 });
    const dir = path.dirname(prefix);
    const base = path.basename(prefix);
    const pages = (await fsp.readdir(dir)).filter(f => f.startsWith(base) && /\.png$/i.test(f)).sort();
    let out = '';
    for (const f of pages) {
      const img = path.join(dir, f);
      created.push(img);
      out += (await ocrImage(img)) + '\n';
    }
    return { text: out, method: 'ocr' };
  } finally {
    for (const f of created) fsp.unlink(f).catch(() => {});
  }
}

// Extract raw text from a file buffer. Never persists the input.
async function extractText(buffer, mimeType, originalName) {
  const isPdf = /pdf/i.test(mimeType || '') || /\.pdf$/i.test(originalName || '');
  if (isPdf) {
    const pdfPath = tmpFile('.pdf');
    await fsp.writeFile(pdfPath, buffer);
    try {
      return await extractTextFromPdf(pdfPath);
    } finally {
      fsp.unlink(pdfPath).catch(() => {});
    }
  }
  // Treat everything else as a raster image.
  const ext = /png/i.test(mimeType || '') ? '.png' : /tif/i.test(mimeType || '') ? '.tif' : '.jpg';
  const imgPath = tmpFile(ext);
  await fsp.writeFile(imgPath, buffer);
  try {
    return { text: await ocrImage(imgPath), method: 'ocr' };
  } finally {
    fsp.unlink(imgPath).catch(() => {});
  }
}

const SYSTEM_PROMPT =
`You extract shipment data from logistics documents (Ocean Bill of Lading, PIB/customs declaration, Surat Jalan/delivery note, invoices).
Return ONLY a JSON object, no prose, no markdown fences, with exactly this shape:
{"fields": { ... }, "confidence": { ... }}
"fields" may contain only these keys (omit any you cannot find — do not guess):
  cargo_type        "Import" or "Domestic"
  consignee         buyer/consignee company name
  project_name      project or reference name if present
  product           goods description (include HS code if shown)
  quantity_mt       gross weight in metric tons, number only e.g. 145.248
  bl_number         Bill of Lading number
  shipping_line     carrier / shipping line
  vessel_name       ocean vessel name
  voyage_number     voyage number (strip a leading "V." prefix)
  pol               port of loading
  pod               port of discharge
  shipment_route    "Direct" or "Transit"
  etd               departure / shipped-on-board date, format YYYY-MM-DD
  eta               arrival date, format YYYY-MM-DD
  shipment_type     "Container" or "Breakbulk"
  vendor_trucking   trucking vendor if stated
  warehouse_location destination warehouse if stated
  pib_billing       PIB billing date, format YYYY-MM-DD
  remarks           short notes: HS code, freight terms, net weight, packages, agent
  year              4-digit year of the shipment (number)
"confidence" maps each field you returned to a number 0..1 (your certainty).
Dates MUST be YYYY-MM-DD. Numbers MUST be plain (no thousands separators, no units).`;

function stripJson(s) {
  if (!s) return '{}';
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const m = body.match(/\{[\s\S]*\}/);
  return m ? m[0] : '{}';
}

function filterFields(obj) {
  const fields = {};
  const src = (obj && obj.fields && typeof obj.fields === 'object') ? obj.fields : {};
  for (const k of FIELD_KEYS) {
    if (src[k] !== undefined && src[k] !== null && src[k] !== '') fields[k] = src[k];
  }
  const confidence = {};
  const csrc = (obj && obj.confidence && typeof obj.confidence === 'object') ? obj.confidence : {};
  for (const k of Object.keys(fields)) {
    const c = Number(csrc[k]);
    confidence[k] = Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5;
  }
  return { fields, confidence };
}

async function parseWithClaude(text) {
  const body = {
    model: process.env.OCR_MODEL || 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `Document text:\n\n${text.slice(0, MAX_TEXT_CHARS)}` }]
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const txt = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return filterFields(JSON.parse(stripJson(txt)));
}

// Best-effort, fixed-format fallback when no API key is available.
function parseWithRegex(text) {
  const fields = {};
  const t = text.replace(/\r/g, '');
  const grab = (re) => { const m = t.match(re); return m ? m[1].trim() : null; };

  const bl = grab(/B[\/\.\s]*L\s*(?:NO\.?|NUMBER)?\s*[:#]?\s*([A-Z0-9\-\/]{5,})/i);
  if (bl) fields.bl_number = bl;
  const vessel = grab(/(?:OCEAN\s+)?VESSEL\s*(?:NAME)?\s*[:#]?\s*([A-Z][A-Z0-9 .\-]{2,40})/i);
  if (vessel) fields.vessel_name = vessel.replace(/\s+VOY.*$/i, '').trim();
  const voy = grab(/VOY(?:AGE)?\.?\s*(?:NO\.?)?\s*[:#]?\s*V?\.?\s*([A-Z0-9\-]{2,15})/i);
  if (voy) fields.voyage_number = voy;
  const pol = grab(/PORT\s+OF\s+LOADING\s*[:#]?\s*([A-Z][A-Z0-9 ,.\-()]{2,40})/i);
  if (pol) fields.pol = pol;
  const pod = grab(/PORT\s+OF\s+DISCHARGE\s*[:#]?\s*([A-Z][A-Z0-9 ,.\-()]{2,40})/i);
  if (pod) fields.pod = pod;
  const gross = grab(/GROSS\s+WEIGHT\s*[:#]?\s*([\d.,]+)\s*(?:MT|KGS?|KG)?/i);
  if (gross) {
    let n = gross.replace(/,/g, '');
    fields.quantity_mt = String(n);
  }
  // ISO or DD MMM YYYY dates near "shipped on board" / "date of issue"
  const etd = grab(/SHIPPED\s+ON\s+BOARD\s*[:#]?\s*([0-9]{1,2}\s+[A-Z]{3,9}\s+[0-9]{4}|[0-9]{4}-[0-9]{2}-[0-9]{2})/i);
  if (etd) fields.etd = etd;

  const confidence = {};
  for (const k of Object.keys(fields)) confidence[k] = 0.4; // regex = low confidence by design
  return { fields, confidence };
}

async function parseFields(text) {
  if (!text || !text.trim()) return { fields: {}, confidence: {}, source: 'empty' };
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const r = await parseWithClaude(text);
      return { ...r, source: 'llm' };
    } catch (e) {
      console.warn('[ocr] Claude parse failed, falling back to regex:', e.message);
    }
  }
  return { ...parseWithRegex(text), source: 'regex' };
}

module.exports = { extractText, parseFields, FIELD_KEYS };
