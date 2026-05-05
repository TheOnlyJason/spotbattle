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

import { loadPreviewVolume, savePreviewVolume } from '@/lib/previewVolume';

type Ctx = {
  volume: number;
  setVolume: (value: number) => void;
  /** Write the current level to storage immediately (e.g. when the slider is released). */
  flushVolumeSave: () => void;
};

const PreviewVolumeContext = createContext<Ctx | null>(null);

const SAVE_DEBOUNCE_MS = 280;

export function PreviewVolumeProvider({ children }: { children: ReactNode }) {
  const [volume, setVolumeState] = useState(1);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  useEffect(() => {
    void loadPreviewVolume().then(setVolumeState);
  }, []);

  const flushVolumeSave = useCallback(() => {
    if (saveTimerRef.current != null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    void savePreviewVolume(volumeRef.current);
  }, []);

  const setVolume = useCallback((value: number) => {
    const v = Math.max(0, Math.min(1, value));
    setVolumeState(v);
    volumeRef.current = v;
    if (saveTimerRef.current != null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void savePreviewVolume(v);
    }, SAVE_DEBOUNCE_MS);
  }, []);

  useEffect(
    () => () => {
      flushVolumeSave();
    },
    [flushVolumeSave],
  );

  const value = useMemo(
    () => ({ volume, setVolume, flushVolumeSave }),
    [volume, setVolume, flushVolumeSave],
  );

  return <PreviewVolumeContext.Provider value={value}>{children}</PreviewVolumeContext.Provider>;
}

export function usePreviewVolume(): Ctx {
  const ctx = useContext(PreviewVolumeContext);
  if (!ctx) throw new Error('usePreviewVolume must be used within PreviewVolumeProvider');
  return ctx;
}

export function usePreviewVolumeOptional(): Ctx | null {
  return useContext(PreviewVolumeContext);
}
