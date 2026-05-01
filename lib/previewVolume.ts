import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'spotbattle.previewVolume';

export async function loadPreviewVolume(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw == null) return 1;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 1;
    return Math.max(0, Math.min(1, n));
  } catch {
    return 1;
  }
}

export async function savePreviewVolume(value: number): Promise<void> {
  const v = Math.max(0, Math.min(1, value));
  try {
    await AsyncStorage.setItem(STORAGE_KEY, String(v));
  } catch {
    /* ignore */
  }
}
