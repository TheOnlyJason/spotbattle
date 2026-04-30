import type { GameTrack } from '@/lib/types';

/**
 * When true: lobby shows “mock tracks” instead of Spotify; you can start a 1-player game for layout work.
 * Set in `.env`: EXPO_PUBLIC_SKIP_SPOTIFY=true (restart Expo with -c).
 * Do not ship production builds with this enabled.
 */
export const UI_DEV_SKIP_SPOTIFY =
  process.env.EXPO_PUBLIC_SKIP_SPOTIFY === '1' ||
  process.env.EXPO_PUBLIC_SKIP_SPOTIFY === 'true';

/** Short HTTPS sample clip (not Spotify) for preview UI. */
const DEMO_PREVIEW =
  'https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3';

export function getMockTrackPoolForUi(): GameTrack[] {
  return [
    {
      id: 'ui-dev-1',
      name: 'Neon Walk (mock)',
      artists: 'Player A',
      imageUrl: null,
      previewUrl: DEMO_PREVIEW,
      sourcePlaylistName: 'Sandbox playlist',
    },
    {
      id: 'ui-dev-2',
      name: 'Late Freight (mock)',
      artists: 'Player B',
      imageUrl: null,
      previewUrl: DEMO_PREVIEW,
      sourcePlaylistName: 'Sandbox playlist',
    },
    {
      id: 'ui-dev-3',
      name: 'Glassline (mock)',
      artists: 'Player A',
      imageUrl: null,
      previewUrl: DEMO_PREVIEW,
      sourcePlaylistName: 'Sandbox playlist',
    },
  ];
}
