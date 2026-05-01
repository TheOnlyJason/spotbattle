/** Path segment for Jackbox-style stream / TV (no secret guess UI). */
export function watchPathForCode(code: string): string {
  return `/watch/${encodeURIComponent(code.trim().toUpperCase())}`;
}

/**
 * Path-only. Same on server and client so web SSR/hydration matches.
 * For absolute URLs, use `watchAbsoluteUrlForCode` inside handlers or `useEffect`.
 */
export function watchUrlForCode(code: string): string {
  return watchPathForCode(code);
}

/** Full URL on web; path-only when `window` is unavailable. Use from handlers, not initial render. */
export function watchAbsoluteUrlForCode(code: string): string {
  const path = watchPathForCode(code);
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${path}`;
  }
  return path;
}
