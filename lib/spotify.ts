import * as AuthSession from 'expo-auth-session';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import type { GameTrack } from '@/lib/types';

WebBrowser.maybeCompleteAuthSession();

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

const ACCESS_KEY = 'spotify_access_token';
const REFRESH_KEY = 'spotify_refresh_token';
const EXPIRES_KEY = 'spotify_expires_at';

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
      clientId,
      scopes: SCOPES,
      redirectUri,
      usePKCE: true,
    },
    discovery
  );
}

export async function exchangeSpotifyCode(
  clientId: string,
  code: string,
  redirectUri: string,
  codeVerifier: string
) {
  const res = await fetch(discovery.tokenEndpoint!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    }),
  });
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(json.error ?? 'Spotify token exchange failed');
  }
  return json;
}

export async function refreshSpotifyToken(clientId: string, refreshToken: string) {
  const res = await fetch(discovery.tokenEndpoint!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(json.error ?? 'Spotify refresh failed');
  }
  return json;
}

export async function saveSpotifySession(
  access: string,
  refresh: string | undefined,
  expiresIn: number
) {
  const expiresAt = Date.now() + expiresIn * 1000 - 30_000;
  await SecureStore.setItemAsync(ACCESS_KEY, access);
  if (refresh) await SecureStore.setItemAsync(REFRESH_KEY, refresh);
  await SecureStore.setItemAsync(EXPIRES_KEY, String(expiresAt));
}

export async function clearSpotifySession() {
  await SecureStore.deleteItemAsync(ACCESS_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(EXPIRES_KEY).catch(() => {});
}

export async function getValidAccessToken(clientId: string): Promise<string | null> {
  const access = await SecureStore.getItemAsync(ACCESS_KEY);
  const expiresAt = Number(await SecureStore.getItemAsync(EXPIRES_KEY));
  const refresh = await SecureStore.getItemAsync(REFRESH_KEY);
  if (access && expiresAt > Date.now()) return access;
  if (refresh) {
    const j = await refreshSpotifyToken(clientId, refresh);
    await saveSpotifySession(
      j.access_token!,
      j.refresh_token ?? refresh,
      j.expires_in ?? 3600
    );
    return j.access_token!;
  }
  return null;
}

async function spotifyFetch(path: string, token: string, init?: RequestInit) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers as object),
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || `Spotify API ${res.status}`);
  }
  return res.json();
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
  let url: string | null = '/me/playlists?limit=50';
  while (url) {
    const page = (await spotifyFetch(url, token)) as SpotifyPlaylistPage;
    out.push(...page.items);
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
  } | null;
};

type SpotifyPlaylistTracksPage = {
  items: SpotifyTrackItem[];
  next: string | null;
};

function toGameTrack(t: SpotifyTrackItem['track']): GameTrack | null {
  if (!t?.id || !t.preview_url) return null;
  return {
    id: t.id,
    name: t.name,
    artists: (t.artists ?? []).map((a) => a.name).join(', ') || 'Unknown',
    imageUrl: t.album?.images?.[0]?.url ?? null,
    previewUrl: t.preview_url,
  };
}

export async function fetchTracksFromPlaylists(
  token: string,
  playlistIds: string[]
): Promise<GameTrack[]> {
  const byId = new Map<string, GameTrack>();
  for (const pid of playlistIds) {
    let url: string | null = `/playlists/${pid}/tracks?limit=100&fields=next,items(track(id,name,preview_url,album(images),artists(name))))`;
    while (url) {
      const page = (await spotifyFetch(url, token)) as SpotifyPlaylistTracksPage;
      for (const it of page.items) {
        const gt = toGameTrack(it.track);
        if (gt) byId.set(gt.id, gt);
      }
      url = page.next
        ? page.next.replace('https://api.spotify.com/v1', '')
        : null;
    }
  }
  return [...byId.values()];
}

type SpotifySavedPage = {
  items: { track: SpotifyTrackItem['track'] }[];
  next: string | null;
};

export async function fetchSavedTracks(token: string): Promise<GameTrack[]> {
  const byId = new Map<string, GameTrack>();
  let url: string | null = '/me/tracks?limit=50';
  while (url) {
    const page = (await spotifyFetch(url, token)) as SpotifySavedPage;
    for (const it of page.items) {
      const gt = toGameTrack(it.track);
      if (gt) byId.set(gt.id, gt);
    }
    url = page.next
      ? page.next.replace('https://api.spotify.com/v1', '')
      : null;
  }
  return [...byId.values()];
}
