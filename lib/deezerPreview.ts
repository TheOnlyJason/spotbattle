import type { GameTrack } from '@/lib/types';
import { Platform } from 'react-native';

/**
 * Spotify’s Web API often omits `preview_url`. Deezer’s public API exposes a 30s MP3
 * `preview` URL when queried by ISRC (`/track/isrc:{code}`). This is a best-effort
 * supplement; not every track exists on Deezer, and large pools take time.
 *
 * **Web:** Deezer does not send `Access-Control-Allow-Origin`, so browsers block direct
 * `fetch` to api.deezer.com. Use same-origin `/api/deezer-preview` (Vercel) or
 * `EXPO_PUBLIC_DEEZER_PREVIEW_PROXY_URL` (e.g. your deployed site) when running web locally.
 *
 * @see https://developers.deezer.com/api/track
 */

const CONCURRENCY = 8;
const BATCH_PAUSE_MS = 150;

function deezerFetchUrl(isrcEncoded: string): string {
  const envProxy = process.env.EXPO_PUBLIC_DEEZER_PREVIEW_PROXY_URL?.replace(/\/$/, '') ?? '';
  if (Platform.OS === 'web') {
    if (envProxy) return `${envProxy}?isrc=${isrcEncoded}`;
    if (typeof window !== 'undefined' && window.location?.host) {
      const { protocol, host } = window.location;
      return `${protocol}//${host}/api/deezer-preview?isrc=${isrcEncoded}`;
    }
  }
  return `https://api.deezer.com/track/isrc:${isrcEncoded}`;
}

async function deezerPreviewUrlForIsrc(isrc: string): Promise<string | null> {
  const clean = isrc.trim().toUpperCase().replace(/\s+/g, '');
  if (!clean) return null;
  const isrcEncoded = encodeURIComponent(clean);
  try {
    const res = await fetch(deezerFetchUrl(isrcEncoded));
    if (!res.ok) return null;
    const j = (await res.json()) as { preview?: string; error?: unknown };
    if (j.error) return null;
    if (typeof j.preview === 'string' && j.preview.startsWith('http')) {
      return j.preview;
    }
    return null;
  } catch {
    return null;
  }
}

/** Fills `previewUrl` from Deezer where Spotify left it null and `isrc` is known. */
export async function enrichTracksWithDeezerPreviews(tracks: GameTrack[]): Promise<GameTrack[]> {
  const indices: number[] = [];
  tracks.forEach((t, i) => {
    if (!t.previewUrl && t.isrc) indices.push(i);
  });
  if (!indices.length) return tracks;

  const out = tracks.map((t) => ({ ...t }));
  for (let i = 0; i < indices.length; i += CONCURRENCY) {
    const batch = indices.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (idx) => {
        const t = out[idx]!;
        const p = await deezerPreviewUrlForIsrc(t.isrc!);
        if (p) out[idx] = { ...t, previewUrl: p };
      })
    );
    if (i + CONCURRENCY < indices.length) {
      await new Promise<void>((r) => setTimeout(r, BATCH_PAUSE_MS));
    }
  }
  return out;
}
