import Slider from '@react-native-community/slider';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '@/constants/theme';
import { usePreviewVolume } from '@/contexts/PreviewVolumeContext';

type Props = {
  /** Tighter layout for small guess-phase headers. */
  compact?: boolean;
};

export function PreviewVolumeSlider({ compact }: Props) {
  const { volume, setVolume, flushVolumeSave } = usePreviewVolume();

  return (
    <View style={[styles.wrap, compact && styles.wrapCompact]}>
      <Text style={[styles.label, compact && styles.labelCompact]}>Preview volume</Text>
      <Slider
        style={styles.slider}
        minimumValue={0}
        maximumValue={1}
        value={volume}
        onValueChange={setVolume}
        onSlidingComplete={flushVolumeSave}
        minimumTrackTintColor={theme.accent}
        maximumTrackTintColor={theme.border}
        thumbTintColor={theme.text}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 10, gap: 4 },
  wrapCompact: { marginBottom: 6 },
  label: { color: theme.textMuted, fontSize: 13, fontWeight: '600' },
  labelCompact: { fontSize: 12 },
  slider: { width: '100%', height: 36 },
});
