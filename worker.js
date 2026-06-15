/**
 * Cloudflare Worker: Deezer ISRC proxy + static Expo web export (SPA).
 * Browsers cannot fetch api.deezer.com (no CORS); the web app calls /api/deezer-preview.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/deezer-preview') {
      return handleDeezerPreview(request);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleDeezerPreview(request) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== 'GET') {
    return Response.json({ error: { message: 'Method not allowed' } }, { status: 405, headers: cors });
  }

  const isrc = new URL(request.url).searchParams.get('isrc') ?? '';
  const clean = isrc.trim().toUpperCase().replace(/\s+/g, '');
  if (!clean) {
    return Response.json({ error: { message: 'missing isrc' } }, { status: 400, headers: cors });
  }

  try {
    const deezerRes = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(clean)}`);
    const text = await deezerRes.text();
    return new Response(text, {
      status: deezerRes.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch {
    return Response.json({ error: { message: 'Deezer proxy failed' } }, { status: 502, headers: cors });
  }
}
