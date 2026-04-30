import * as AuthSession from 'expo-auth-session';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { browserLocalStorageAsync } from '@/lib/browserStorage';
import { shuffleInPlace } from '@/lib/gameLogic';
import type { GameTrack } from '@/lib/types';

// On web, only call `maybeCompleteAuthSession` from `app/spotify-auth.tsx` (OAuth return URL).
// Running it here when this module loads from the main frame causes a cross-origin error
// (accessing opener/parent Location from http://127.0.0.1:8081).
if (Platform.OS !== 'web') {
  WebBrowser.maybeCompleteAuthSession();
}

const discovery: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: 'https://accounts.spotify.com/authorize',
  tokenEndpoint: 'https://accounts.spotify.com/api/token',
};

const SCOPES = [
  'user-read-email',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
];

/** Avoid multi-minute hangs when users have huge libraries. */
const MAX_PLAYLIST_IDS = 40;
const MAX_PLAYLIST_LIST_PAGES = 15;
const MAX_PLAYLIST_TRACK_PAGES = 25;
const MAX_SAVED_TRACK_PAGES = 30;
const SPOTIFY_FETCH_TIMEOUT_MS = 25_000;

function withMarket(path: string): string {
  if (path.includes('market=')) return path;
  return path.includes('?') ? `${path}&market=from_token` : `${path}?market=from_token`;
}

const ACCESS_KEY = 'spotify_access_token';
const REFRESH_KEY = 'spotify_refresh_token';
const EXPIRES_KEY = 'spotify_expires_at';

/** `expo-secure-store` only registers native modules on iOS/Android; web has no `setValueWithKeyAsync`. */
const USE_SECURE_STORE = Platform.OS === 'ios' || Platform.OS === 'android';

async function sessionStoreSet(key: string, value: string) {
  if (USE_SECURE_STORE) await SecureStore.setItemAsync(key, value);
  else await browserLocalStorageAsync.setItem(key, value);
}

async function sessionStoreGet(key: string): Promise<string | null> {
  if (USE_SECURE_STORE) return SecureStore.getItemAsync(key);
  return browserLocalStorageAsync.getItem(key);
}

async function sessionStoreDelete(key: string) {
  if (USE_SECURE_STORE) await SecureStore.deleteItemAsync(key).catch(() => {});
  else await browserLocalStorageAsync.removeItem(key).catch(() => {});
}

/**
 * Spotify (2025+): `localhost` is not allowed; loopback must use `127.0.0.1` or `[::1]`.
 * @see https://developer.spotify.com/blog/2025-02-12-increasing-the-security-requirements-for-integrating-with-spotify
 */
function normalizeSpotifyWebRedirect(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.hostname === 'localhost') {
      u.hostname = '127.0.0.1';
      return u.toString().replace(/\/$/, '');
    }
    if (u.hostname === '::1') {
      u.hostname = '[::1]';
      return u.toString().replace(/\/$/, '');
    }
    return uri.replace(/\/$/, '');
  } catch {
    return uri;
  }
}

/**
 * Must match a Redirect URI in the Spotify Developer Dashboard (exact string).
 * - Dev client / TestFlight / production: stable `spotbattle://spotify-auth`
 * - Expo Go: `exp://...:PORT/--/spotify-auth` (IP/host changes with your network)
 * - Web: `http://127.0.0.1:PORT/spotify-auth` (never `localhost` — Spotify policy)
 */
export function spotifyRedirectUri(): string {
  if (Platform.OS === 'web') {
    const raw = AuthSession.makeRedirectUri({ scheme: 'spotbattle', path: 'spotify-auth' });
    return normalizeSpotifyWebRedirect(raw);
  }
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    return AuthSession.makeRedirectUri({ scheme: 'spotbattle', path: 'spotify-auth' });
  }
  return 'spotbattle://spotify-auth';
}

/** True when Spotify needs the dynamic redirect string registered (not only spotbattle://). */
export function spotifyUsesDynamicRedirect(): boolean {
  return (
    Platform.OS === 'web' || Constants.executionEnvironment === ExecutionEnvironment.StoreClient
  );
}

export function useSpotifyAuthRequest(clientId: string) {
  const redirectUri = spotifyRedirectUri();
  return AuthSession.useAuthRequest(
    {
      clientId: clientId.trim(),
      scopes: SCOPES,
      redirectUri,
      usePKCE: true,
    },
    discovery
  );
}

type SpotifyTokenJson = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

/**
 * Spotify expects a form-encoded POST body. Passing a plain string avoids RN/Hermes
 * edge cases where URLSearchParams as `body` is not serialized and Spotify responds with
 * `unsupported_grant_type` / "grant_type parameter is missing".
 */
async function postSpotifyTokenForm(params: Record<string, string>): Promise<SpotifyTokenJson> {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(discovery.tokenEndpoint!, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const json = (await res.json()) as SpotifyTokenJson;
  if (!res.ok || !json.access_token) {
    const parts = [json.error, json.error_description].filter(
      (p): p is string => typeof p === 'string' && p.length > 0
    );
    throw new Error(parts.join(': ') || `Spotify token error (${res.status})`);
  }
  return json;
}

export async function exchangeSpotifyCode(
  clientId: string,
  code: string,
  redirectUri: string,
  codeVerifier: string
) {
  return postSpotifyTokenForm({
    grant_type: 'authorization_code',
    code: code.trim(),
    redirect_uri: redirectUri,
    client_id: clientId.trim(),
    code_verifier: codeVerifier,
  });
}

export async function refreshSpotifyToken(clientId: string, refreshToken: string) {
  const rt = refreshToken.trim();
  if (!rt) {
    throw new Error('No refresh token');
  }
  return postSpotifyTokenForm({
    grant_type: 'refresh_token',
    refresh_token: rt,
    client_id: clientId.trim(),
  });
}

export async function saveSpotifySession(
  access: string,
  refresh: string | undefined,
  expiresIn: number
) {
  const expiresAt = Date.now() + expiresIn * 1000 - 30_000;
  await sessionStoreSet(ACCESS_KEY, access);
  if (refresh) await sessionStoreSet(REFRESH_KEY, refresh);
  await sessionStoreSet(EXPIRES_KEY, String(expiresAt));
}

export async function clearSpotifySession() {
  await sessionStoreDelete(ACCESS_KEY);
  await sessionStoreDelete(REFRESH_KEY);
  await sessionStoreDelete(EXPIRES_KEY);
}

export async function getValidAccessToken(clientId: string): Promise<string | null> {
  const id = clientId.trim();
  if (!id) return null;

  const access = await sessionStoreGet(ACCESS_KEY);
  const expiresRaw = await sessionStoreGet(EXPIRES_KEY);
  const expiresAt = Number(expiresRaw);
  const refresh = (await sessionStoreGet(REFRESH_KEY))?.trim() ?? '';

  const accessValid =
    Boolean(access) && Number.isFinite(expiresAt) && !Number.isNaN(expiresAt) && expiresAt > Date.now();
  if (accessValid) return access;

  if (refresh) {
    try {
      const j = await refreshSpotifyToken(id, refresh);
      await saveSpotifySession(
        j.access_token!,
        j.refresh_token ?? refresh,
        j.expires_in ?? 3600
      );
      return j.access_token!;
    } catch {
      await clearSpotifySession();
      throw new Error(
        'Spotify session expired or could not be refreshed. Tap “Log in with Spotify” again. ' +
          '(unsupported_grant_type usually means the token request was not accepted—re‑login fixes it.)'
      );
    }
  }
  return null;
}

function formatSpotifyErrorBody(body: string, status: number): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: string; status?: number } | string };
    if (typeof j.error === 'object' && j.error?.message) {
      return `Spotify (${j.error.status ?? status}): ${j.error.message}`;
    }
    if (typeof j.error === 'string') {
      return `Spotify (${status}): ${j.error}`;
    }
  } catch {
    /* not JSON */
  }
  const trimmed = body.trim();
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed || `Spotify API ${status}`;
}

function spotifyTransientHint(status: number, bodyText: string): string {
  const b = bodyText.toLowerCase();
  if (status === 502 || status === 503 || status === 504) {
    if (b.includes('unexpected error') || b.includes('try again')) {
      return (
        ' (This app already retried several times; try again in a few minutes.)' +
        ' Temporary Spotify API issue—not your Vercel or redirect URI. status.spotify.com if it persists.'
      );
    }
    return " Spotify’s servers may be busy—try again shortly.";
  }
  if (status === 429) {
    return ' Rate limited—wait a bit before trying again.';
  }
  return '';
}

function spotifyRetryDelayMs(attempt: number, status: number, res: Response): number {
  if (status === 429) {
    const ra = res.headers.get('Retry-After');
    const sec = parseInt(ra ?? '', 10);
    if (!Number.isNaN(sec) && sec >= 1) {
      return Math.min(sec * 1000, 15_000);
    }
  }
  if (status === 502 || status === 503 || status === 504) {
    return Math.min(1800 * 2 ** attempt, 14_000);
  }
  return 600 * 2 ** attempt;
}

async function spotifyFetch(path: string, token: string, init?: RequestInit) {
  const maxAttempts = 6;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SPOTIFY_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`https://api.spotify.com/v1${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init?.headers as object),
        },
      });

      if (res.ok) {
        return (await res.json()) as unknown;
      }

      const bodyText = await res.text();
      const canRetryHttp =
        attempt < maxAttempts - 1 &&
        (res.status === 502 || res.status === 503 || res.status === 504 || res.status === 429);

      if (canRetryHttp) {
        await new Promise<void>((r) => setTimeout(r, spotifyRetryDelayMs(attempt, res.status, res)));
        continue;
      }

      throw new Error(
        formatSpotifyErrorBody(bodyText, res.status) + spotifyTransientHint(res.status, bodyText)
      );
    } catch (e) {
      if (e instanceof Error && (e.name === 'AbortError' || e.message === 'Aborted')) {
        throw new Error(
          'Spotify request timed out. Try again, or switch to Liked songs if you have many playlists.'
        );
      }
      if (e instanceof Error && e.message.startsWith('Spotify (')) {
        throw e;
      }
      if (attempt < maxAttempts - 1) {
        await new Promise<void>((r) => setTimeout(r, 600 * 2 ** attempt));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(
    'Spotify did not respond after several tries. Their API may be down—check status.spotify.com and try again later.'
  );
}

export type SpotifyUser = { id: string; display_name: string | null };

export async function fetchSpotifyProfile(token: string): Promise<SpotifyUser> {
  return spotifyFetch('/me', token) as Promise<SpotifyUser>;
}

type SpotifyPlaylistPage = {
  items: { id: string; name: string }[];
  next: string | null;
};

export async function fetchAllPlaylistIds(token: string): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  let url: string | null = withMarket('/me/playlists?limit=50');
  let pages = 0;
  while (url && pages < MAX_PLAYLIST_LIST_PAGES) {
    pages += 1;
    const page = (await spotifyFetch(url, token)) as SpotifyPlaylistPage;
    const items = page.items ?? [];
    out.push(...items);
    url = page.next
      ? page.next.replace('https://api.spotify.com/v1', '')
      : null;
  }
  return out;
}

type SpotifyTrackItem = {
  track: {
    id: string | null;
    name: string;
    preview_url: string | null;
    album?: { images?: { url: string }[] };
    artists?: { name: string }[];
    external_ids?: { isrc?: string | null };
  } | null;
};

type SpotifyPlaylistTracksPage = {
  items: SpotifyTrackItem[];
  next: string | null;
};

function toGameTrack(t: SpotifyTrackItem['track']): GameTrack | null {
  if (!t?.id) return null;
  const isrc = t.external_ids?.isrc?.trim() || null;
  return {
    id: t.id,
    name: t.name,
    artists: (t.artists ?? []).map((a) => a.name).join(', ') || 'Unknown',
    imageUrl: t.album?.images?.[0]?.url ?? null,
    previewUrl: t.preview_url ?? null,
    ...(isrc ? { isrc } : {}),
  };
}

export type FetchTracksSampleOptions = {
  /** When set, stop after enough candidates, shuffle, and return at most this many tracks. */
  sampleTarget?: number;
};

export async function fetchTracksFromPlaylists(
  token: string,
  playlistIds: string[],
  options?: FetchTracksSampleOptions
): Promise<GameTrack[]> {
  const k = options?.sampleTarget;
  const byId = new Map<string, GameTrack>();
  const pids = [...playlistIds];
  shuffleInPlace(pids);
  const capped = pids.slice(0, MAX_PLAYLIST_IDS);
  let scannedItems = 0;

  outer: for (const pid of capped) {
    let url: string | null = withMarket(
      `/playlists/${encodeURIComponent(pid)}/tracks?limit=100&fields=${encodeURIComponent('next,items(track(id,name,preview_url,album(images),artists(name),external_ids(isrc)))')}`
    );
    let pages = 0;
    while (url && pages < MAX_PLAYLIST_TRACK_PAGES) {
      pages += 1;
      const page = (await spotifyFetch(url, token)) as SpotifyPlaylistTracksPage;
      const items = page.items ?? [];
      for (const it of items) {
        const gt = toGameTrack(it.track);
        if (gt) {
          byId.set(gt.id, gt);
          scannedItems += 1;
        }
        if (k) {
          const enough =
            byId.size >= Math.min(180, k * 3) ||
            (byId.size >= k && scannedItems >= Math.max(40, k * 6));
          if (enough || scannedItems >= k * 40) break outer;
        }
      }
      url = page.next
        ? page.next.replace('https://api.spotify.com/v1', '')
        : null;
    }
  }
  const values = [...byId.values()];
  if (k && values.length > k) {
    shuffleInPlace(values);
    return values.slice(0, k);
  }
  return values;
}

type SpotifySavedPage = {
  items: { track: SpotifyTrackItem['track'] }[];
  next: string | null;
};

export async function fetchSavedTracks(
  token: string,
  options?: FetchTracksSampleOptions
): Promise<GameTrack[]> {
  const k = options?.sampleTarget;
  const byId = new Map<string, GameTrack>();
  const savedFields = encodeURIComponent(
    'next,items(track(id,name,preview_url,album(images),artists(name),external_ids(isrc)))'
  );
  let url: string | null = withMarket(`/me/tracks?limit=50&fields=${savedFields}`);
  let pages = 0;
  let scannedItems = 0;
  while (url && pages < MAX_SAVED_TRACK_PAGES) {
    pages += 1;
    const page = (await spotifyFetch(url, token)) as SpotifySavedPage;
    const items = page.items ?? [];
    for (const it of items) {
      const gt = toGameTrack(it.track);
      if (gt) {
        byId.set(gt.id, gt);
        scannedItems += 1;
      }
      if (k) {
        const enough =
          byId.size >= Math.min(180, k * 3) ||
          (byId.size >= k && scannedItems >= Math.max(40, k * 6));
        if (enough || scannedItems >= k * 40) {
          url = null;
          break;
        }
      }
    }
    url = url
      ? page.next
        ? page.next.replace('https://api.spotify.com/v1', '')
        : null
      : null;
  }
  const values = [...byId.values()];
  if (k && values.length > k) {
    shuffleInPlace(values);
    return values.slice(0, k);
  }
  return values;
}
