/** Path for the shared speaker / TV (plays preview + shows titles during guess). */
export function partyDeckPathForCode(code: string): string {
  return `/party-deck/${encodeURIComponent(code.trim().toUpperCase())}`;
}

/**
 * Path-only (e.g. `/party-deck/ABCD`). Same on server and client so web SSR/hydration matches.
 * For copy/share, use `partyDeckAbsoluteUrlForCode` inside handlers or `useEffect`.
 */
export function partyDeckUrlForCode(code: string): string {
  return partyDeckPathForCode(code);
}

/** Full URL on web; path-only when `window` is unavailable (e.g. native / SSR). Use from handlers, not initial render. */
export function partyDeckAbsoluteUrlForCode(code: string): string {
  const path = partyDeckPathForCode(code);
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${path}`;
  }
  return path;
}
