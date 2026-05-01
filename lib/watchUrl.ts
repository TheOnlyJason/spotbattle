/** Path segment for Jackbox-style stream / TV (no secret guess UI). */
export function watchPathForCode(code: string): string {
  return `/watch/${encodeURIComponent(code.trim().toUpperCase())}`;
}

/** Full URL on web; path-only elsewhere (e.g. Expo Go). */
export function watchUrlForCode(code: string): string {
  const c = code.trim().toUpperCase();
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/watch/${c}`;
  }
  return watchPathForCode(c);
}
