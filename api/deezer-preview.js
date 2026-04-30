/**
 * Server-side proxy for Deezer ISRC lookup. Browsers cannot read api.deezer.com
 * (no Access-Control-Allow-Origin), so the web app calls this same-origin route.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: { message: 'Method not allowed' } });
    return;
  }
  const raw = typeof req.query?.isrc === 'string' ? req.query.isrc : '';
  const clean = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (!clean) {
    res.status(400).json({ error: { message: 'missing isrc' } });
    return;
  }
  try {
    const deezerRes = await fetch(
      `https://api.deezer.com/track/isrc:${encodeURIComponent(clean)}`
    );
    const text = await deezerRes.text();
    res.status(deezerRes.status).setHeader('Content-Type', 'application/json').send(text);
  } catch {
    res.status(502).json({ error: { message: 'Deezer proxy failed' } });
  }
};
