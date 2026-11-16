// Vercel serverless function: stores the whole ERP state as ONE document in MongoDB.
//   GET  /api/state[?rev=N]  -> { exists, rev, data } | { unchanged:true, rev }
//   PUT  /api/state          -> body { baseRev, data }  -> { ok, rev }  (409 if someone else saved first)
// Auth: HTTP Basic (Login ID + Password) checked against env APP_USER_ID / APP_PASSWORD.
const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const DB_NAME = process.env.MONGODB_DB || 'vigilant_erp';
const DOC_ID = 'main';
const MAX_BYTES = 4 * 1024 * 1024;      // Vercel body limit is ~4.5 MB
const HISTORY_KEEP = 30;                // safety snapshots kept
const HISTORY_EVERY_MS = 10 * 60 * 1000;

let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    clientPromise = new MongoClient(process.env.MONGODB_URI, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 8000
    }).connect();
    clientPromise.catch(() => { clientPromise = null; });
  }
  return clientPromise;
}

function safeEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isAuthed(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  let dec = '';
  try { dec = Buffer.from(h.slice(6), 'base64').toString('utf8'); } catch (e) { return false; }
  const i = dec.indexOf(':');
  if (i < 0) return false;
  const idOk = safeEq(dec.slice(0, i), process.env.APP_USER_ID || 'admin');
  const pwOk = safeEq(dec.slice(i + 1), process.env.APP_PASSWORD || 'vigilant123');
  return idOk && pwOk;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (!process.env.MONGODB_URI) return res.status(503).json({ error: 'MONGODB_URI not set' });

  if (!isAuthed(req)) {
    await sleep(600); // slows down password guessing
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const db = (await getClient()).db(DB_NAME);
    const col = db.collection('erp_state');

    if (req.method === 'GET') {
      const doc = await col.findOne({ _id: DOC_ID });
      if (!doc) return res.status(200).json({ exists: false, rev: 0 });
      if (String(req.query && req.query.rev) === String(doc.rev)) {
        return res.status(200).json({ unchanged: true, exists: true, rev: doc.rev });
      }
      return res.status(200).json({ exists: true, rev: doc.rev, data: doc.data, updatedAt: doc.updatedAt });
    }

    if (req.method === 'PUT') {
      const body = req.body || {};
      const baseRev = Number(body.baseRev) || 0;
      const data = body.data;
      if (typeof data !== 'string' || data.length < 2 || data.length > MAX_BYTES) {
        return res.status(400).json({ error: 'Invalid or too large payload' });
      }
      let parsed;
      try { parsed = JSON.parse(data); } catch (e) { return res.status(400).json({ error: 'Payload is not JSON' }); }
      if (!parsed || typeof parsed !== 'object' || !parsed.monthWorkspaces) {
        return res.status(400).json({ error: 'Not a Vigilant ERP state' });
      }

      const now = new Date();
      const current = await col.findOne({ _id: DOC_ID });

      if (!current) {
        if (baseRev !== 0) return res.status(409).json({ error: 'conflict', rev: 0 });
        try {
          await col.insertOne({ _id: DOC_ID, rev: 1, data, updatedAt: now });
        } catch (e) {
          if (e && e.code === 11000) return res.status(409).json({ error: 'conflict' });
          throw e;
        }
        return res.status(200).json({ ok: true, rev: 1 });
      }

      if (current.rev !== baseRev) return res.status(409).json({ error: 'conflict', rev: current.rev });

      const updated = await col.findOneAndUpdate(
        { _id: DOC_ID, rev: baseRev },
        { $set: { data, updatedAt: now }, $inc: { rev: 1 } },
        { returnDocument: 'after' }
      );
      const newDoc = updated && (updated.value !== undefined ? updated.value : updated);
      if (!newDoc || newDoc.rev === undefined) return res.status(409).json({ error: 'conflict' });

      // Safety snapshots of the PREVIOUS version (time-based, or whenever data shrinks a lot).
      try {
        const hist = db.collection('erp_state_history');
        const last = await hist.find({}).sort({ savedAt: -1 }).limit(1).toArray();
        const old = !last.length || (now - last[0].savedAt) > HISTORY_EVERY_MS;
        const shrank = data.length < current.data.length * 0.5;
        if (old || shrank) {
          await hist.insertOne({ savedAt: now, rev: current.rev, data: current.data });
          const ids = await hist.find({}, { projection: { _id: 1 } }).sort({ savedAt: -1 }).skip(HISTORY_KEEP).toArray();
          if (ids.length) await hist.deleteMany({ _id: { $in: ids.map(d => d._id) } });
        }
      } catch (e) { /* snapshot failure must never block saving */ }

      return res.status(200).json({ ok: true, rev: newDoc.rev });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('api/state error:', err && err.message);
    return res.status(500).json({ error: 'Database error' });
  }
};
