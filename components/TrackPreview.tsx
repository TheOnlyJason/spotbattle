import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import { useEffect } from 'react';

type Props = {
  uri: string | null;
  /** When this changes, preview restarts (e.g. new round). */
  replayToken?: string | number;
};

/** Plays a remote preview URL during the guess phase (expo-audio). */
export function TrackPreview({ uri, replayToken = 0 }: Props) {
  const player = useAudioPlayer(uri);

  useEffect(() => {
    void setAudioModeAsync({ playsInSilentMode: true });
  }, []);

  useEffect(() => {
    if (!uri) {
      try {
        player.pause();
      } catch {
        /* noop */
      }
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        await player.seekTo(0);
        if (!cancelled) player.play();
      } catch {
        /* preview may fail (simulator, CORS on web, etc.) */
      }
    };
    void run();
    return () => {
      cancelled = true;
      try {
        player.pause();
      } catch {
        /* noop */
      }
    };
  }, [uri, replayToken, player]);

  return null;
}
