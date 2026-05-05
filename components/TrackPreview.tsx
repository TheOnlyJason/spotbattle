import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text } from 'react-native';

import { usePreviewVolumeOptional } from '@/contexts/PreviewVolumeContext';

type Props = {
  uri: string | null;
  /** When this changes, preview restarts (e.g. new round). */
  replayToken?: string | number;
};

async function configurePreviewAudioSession(): Promise<void> {
  await setAudioModeAsync({
    playsInSilentMode: true,
    interruptionMode: 'mixWithOthers',
    allowsRecording: false,
  });
}

const tapHelpPlatforms = Platform.OS === 'web' || Platform.OS === 'ios';

/** Plays a remote preview URL during the guess phase (expo-audio). */
export function TrackPreview({ uri, replayToken = 0 }: Props) {
  const previewVol = usePreviewVolumeOptional();
  const volume = previewVol?.volume ?? 1;
  const player = useAudioPlayer(uri);
  const status = useAudioPlayerStatus(player);
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    try {
      player.volume = volume;
    } catch {
      /* noop */
    }
  }, [player, volume]);

  /** Web autoplay policy + iOS session/route edge cases: offer explicit tap to start. */
  const [needsTapToPlay, setNeedsTapToPlay] = useState(false);

  useEffect(() => {
    if (status.playing) setNeedsTapToPlay(false);
  }, [status.playing]);

  useEffect(() => {
    setNeedsTapToPlay(false);
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
        await configurePreviewAudioSession();
        if (cancelled) return;
        await player.seekTo(0);
        if (!cancelled) player.play();
      } catch {
        if (tapHelpPlatforms) setNeedsTapToPlay(true);
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

  useEffect(() => {
    if (!tapHelpPlatforms || !uri) return;
    const t = setTimeout(() => {
      const s = statusRef.current;
      if (
        s.isLoaded &&
        s.duration > 0 &&
        !s.playing &&
        s.currentTime < 0.05 &&
        !s.isBuffering
      ) {
        setNeedsTapToPlay(true);
      }
    }, 550);
    return () => clearTimeout(t);
  }, [uri, replayToken, status.isLoaded, status.duration]);

  const unlockPreviewWithGesture = () => {
    setNeedsTapToPlay(false);
    void (async () => {
      try {
        await configurePreviewAudioSession();
        await player.seekTo(0);
        player.play();
      } catch {
        /* noop */
      }
    })();
  };

  if (tapHelpPlatforms && needsTapToPlay && uri) {
    const sub =
      Platform.OS === 'web'
        ? 'Browsers block audio until you tap.'
        : 'Tap to retry. Also check the Ring/Silent switch (ring mode), volume, and Bluetooth output (e.g. AirPods).';
    return (
      <Pressable
        onPress={unlockPreviewWithGesture}
        style={styles.tapUnlock}
        accessibilityRole="button"
        accessibilityLabel="Tap to play preview sound">
        <Text style={styles.tapUnlockText}>Tap to play preview sound</Text>
        <Text style={styles.tapUnlockSub}>{sub}</Text>
      </Pressable>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  tapUnlock: {
    marginBottom: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  tapUnlockText: { color: '#f8fafc', fontSize: 15, fontWeight: '600' },
  tapUnlockSub: { color: 'rgba(248,250,252,0.72)', fontSize: 12, marginTop: 4, lineHeight: 16 },
});
