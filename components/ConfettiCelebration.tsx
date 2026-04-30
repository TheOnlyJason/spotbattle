import { useEffect, useMemo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing,
  type SharedValue,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

const DURATION_MS = 2800;
const PARTICLE_COUNT = 44;

const CONFETTI_COLORS = [
  '#f472b6',
  '#22d3ee',
  '#a3e635',
  '#fbbf24',
  '#c084fc',
  '#fb7185',
  '#38bdf8',
  '#4ade80',
  '#facc15',
  '#f97316',
  '#818cf8',
];

type ParticleConfig = {
  ox: number;
  oy: number;
  vx: number;
  vy: number;
  g: number;
  r0: number;
  spin: number;
  w: number;
  h: number;
  color: string;
  curve: number;
};

function buildParticles(width: number, height: number): ParticleConfig[] {
  return Array.from({ length: PARTICLE_COUNT }, (_, i) => {
    const spread = width * 0.85;
    const ox = width * 0.075 + Math.random() * spread;
    const oy = -30 - Math.random() * (height * 0.15);
    const angle = (Math.random() - 0.5) * 1.1 + Math.PI / 2;
    const speed = 220 + Math.random() * 320;
    return {
      ox,
      oy,
      vx: Math.cos(angle) * speed * (0.35 + Math.random() * 0.65),
      vy: Math.sin(angle) * speed * 0.45,
      g: 520 + Math.random() * 280,
      r0: Math.random() * 360,
      spin: (Math.random() - 0.5) * 1800,
      w: 6 + Math.random() * 10,
      h: 8 + Math.random() * 14,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length]!,
      curve: (Math.random() - 0.5) * 100,
    };
  });
}

function ConfettiPiece({
  progress,
  ox,
  oy,
  vx,
  vy,
  g,
  r0,
  spin,
  w,
  h,
  color,
  curve,
}: ParticleConfig & { progress: SharedValue<number> }) {
  const style = useAnimatedStyle(() => {
    'worklet';
    const t = progress.value * 2.85;
    const x = ox + vx * t + curve * t * 0.018;
    const y = oy + vy * t + 0.5 * g * t * t * 0.012;
    const rot = r0 + spin * progress.value;
    let opacity = 1;
    if (progress.value < 0.06) opacity = progress.value / 0.06;
    else if (progress.value > 0.82) opacity = (1 - progress.value) / 0.18;
    return {
      position: 'absolute' as const,
      left: 0,
      top: 0,
      width: w,
      height: h,
      backgroundColor: color,
      borderRadius: 2,
      opacity,
      transform: [{ translateX: x }, { translateY: y }, { rotate: `${rot}deg` }],
    };
  });

  return <Animated.View style={style} />;
}

type Props = {
  onComplete: () => void;
};

/**
 * Full-screen burst (pointerEvents none). Mount with a new key per reveal to replay.
 */
export function ConfettiCelebration({ onComplete }: Props) {
  const { width, height } = useWindowDimensions();
  const progress = useSharedValue(0);
  const particles = useMemo(() => buildParticles(width, height), [width, height]);

  useEffect(() => {
    progress.value = 0;
    progress.value = withTiming(
      1,
      { duration: DURATION_MS, easing: Easing.out(Easing.cubic) },
      (finished) => {
        if (finished) runOnJS(onComplete)();
      }
    );
  }, [onComplete, progress]);

  return (
    <View style={[StyleSheet.absoluteFillObject, styles.layer]} pointerEvents="none">
      {particles.map((p, i) => (
        <ConfettiPiece key={i} progress={progress} {...p} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    zIndex: 200,
    elevation: 200,
  },
});
