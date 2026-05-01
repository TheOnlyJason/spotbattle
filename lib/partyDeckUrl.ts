/** Path for the shared speaker / TV (plays preview + shows titles during guess). */
export function partyDeckPathForCode(code: string): string {
  return `/party-deck/${encodeURIComponent(code.trim().toUpperCase())}`;
}

/** Full URL on web; path-only elsewhere (e.g. Expo Go). */
export function partyDeckUrlForCode(code: string): string {
  const c = code.trim().toUpperCase();
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/party-deck/${c}`;
  }
  return partyDeckPathForCode(c);
}
