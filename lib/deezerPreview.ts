import type { GameTrack } from '@/lib/types';

/**
 * Spotify’s Web API often omits `preview_url`. Deezer’s public API exposes a 30s MP3
 * `preview` URL when queried by ISRC (`/track/isrc:{code}`). This is a best-effort
 * supplement; not every track exists on Deezer, and large pools take time.
 *
 * @see https://developers.deezer.com/api/track
 */

const CONCURRENCY = 8;
const BATCH_PAUSE_MS = 150;

async function deezerPreviewUrlForIsrc(isrc: string): Promise<string | null> {
  const clean = isrc.trim().toUpperCase().replace(/\s+/g, '');
  if (!clean) return null;
  try {
    const res = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(clean)}`);
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
