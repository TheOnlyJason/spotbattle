import Ionicons from '@expo/vector-icons/Ionicons';
import Slider from '@react-native-community/slider';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '@/constants/theme';
import { usePreviewVolumeOptional } from '@/contexts/PreviewVolumeContext';

type PreviewCtx = {
  previewUri: string | null;
  volume: number;
  setVolume: (v: number) => void;
};

const TrackPreviewContext = createContext<PreviewCtx | null>(null);

function useTrackPreviewOptional(): PreviewCtx | null {
  return useContext(TrackPreviewContext);
}

type HostProps = {
  uri: string | null;
  /** When this changes, preview restarts (e.g. new round). */
  replayToken?: string | number;
  children: ReactNode;
};

async function configurePreviewAudioSession(): Promise<void> {
  await setAudioModeAsync({
    playsInSilentMode: true,
    interruptionMode: 'mixWithOthers',
    allowsRecording: false,
  });
}

const tapHelpPlatforms = Platform.OS === 'web' || Platform.OS === 'ios';

/**
 * Wraps the guess UI: owns the audio player, exposes volume to {@link PreviewVolumeControl},
 * and renders children (place {@link TrackPreviewSlot} where the tap-to-play banner should appear).
 */
export function TrackPreviewHost({ uri, replayToken = 0, children }: HostProps) {
  const player = useAudioPlayer(uri);
  const status = useAudioPlayerStatus(player);
  const statusRef = useRef(status);
  statusRef.current = status;

  const persistedVol = usePreviewVolumeOptional();
  const [localVolume, setLocalVolume] = useState(1);
  const volume = persistedVol?.volume ?? localVolume;
  const setVolume = useCallback(
    (v: number) => {
      const next = Math.max(0, Math.min(1, v));
      if (persistedVol) persistedVol.setVolume(next);
      else setLocalVolume(next);
    },
    [persistedVol],
  );

  useEffect(() => {
    try {
      player.volume = volume;
    } catch {
      /* noop */
    }
  }, [player, volume]);

  const ctx = useMemo<PreviewCtx>(
    () => ({ previewUri: uri, volume, setVolume }),
    [uri, volume, setVolume],
  );

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

  const unlockPreviewWithGesture = useCallback(() => {
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
  }, [player]);

  return (
    <TrackPreviewContext.Provider value={ctx}>
      <TrackPreviewPlaybackContext.Provider
        value={{ needsTapToPlay, unlockPreviewWithGesture, previewUri: uri }}>
        {children}
      </TrackPreviewPlaybackContext.Provider>
    </TrackPreviewContext.Provider>
  );
}

type PlaybackCtx = {
  needsTapToPlay: boolean;
  unlockPreviewWithGesture: () => void;
  previewUri: string | null;
};

const TrackPreviewPlaybackContext = createContext<PlaybackCtx | null>(null);

/** Tap-to-play strip when the OS/browser blocks autoplay (same positions as before). */
export function TrackPreviewSlot() {
  const playback = useContext(TrackPreviewPlaybackContext);
  if (!playback) return null;
  const { needsTapToPlay, unlockPreviewWithGesture, previewUri } = playback;
  if (!tapHelpPlatforms || !needsTapToPlay || !previewUri) return null;
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

type TrackPreviewProps = {
  uri: string | null;
  replayToken?: string | number;
};

/** Headless playback + slot only — use when there is no separate host (legacy). */
export function TrackPreview({ uri, replayToken = 0 }: TrackPreviewProps) {
  return (
    <TrackPreviewHost uri={uri} replayToken={replayToken}>
      <TrackPreviewSlot />
    </TrackPreviewHost>
  );
}

/**
 * Inline header volume: tap the speaker to show a slider on the same row as siblings (e.g. timer).
 * No panel — sits in `guessHeaderRight` as `[timer][slider][icon]`.
 */
export function PreviewVolumeControl() {
  const ctx = useTrackPreviewOptional();
  const [open, setOpen] = useState(false);

  if (!ctx?.previewUri) return null;

  const { volume, setVolume } = ctx;
  const iconName =
    volume < 0.01 ? 'volume-mute' : volume < 0.45 ? 'volume-low' : ('volume-high' as const);

  return (
    <View style={[styles.volumeRoot, open && styles.volumeRootExpanded]} collapsable={false}>
      {open ? (
        <Slider
          style={styles.volumeSliderInline}
          minimumValue={0}
          maximumValue={1}
          step={0.02}
          value={volume}
          onValueChange={setVolume}
          minimumTrackTintColor={theme.accent}
          maximumTrackTintColor="rgba(139,143,163,0.28)"
          thumbTintColor="#d1fae5"
          tapToSeek
          accessibilityLabel="Preview volume"
        />
      ) : null}
      <Pressable
        onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => [styles.volumeIconBtn, pressed && styles.volumeIconBtnPressed]}
        accessibilityRole="button"
        accessibilityLabel={open ? 'Hide volume slider' : 'Show volume slider'}
        accessibilityState={{ expanded: open }}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Ionicons name={iconName} size={22} color={theme.accent} />
      </Pressable>
    </View>
  );
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
  volumeRoot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    zIndex: 50,
  },
  /** Fills space between the timer and the trailing icon so the slider shares one row with the timer. */
  volumeRootExpanded: {
    flex: 1,
    minWidth: 0,
  },
  volumeIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  volumeIconBtnPressed: {
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  volumeSliderInline: {
    flex: 1,
    minWidth: 72,
    ...Platform.select({
      web: { height: 14, cursor: 'pointer' as const },
      ios: { height: 18 },
      default: { height: 20 },
    }),
  },
});
