import FontAwesome from '@expo/vector-icons/FontAwesome';
import { DarkTheme, ThemeProvider } from '@react-navigation/native';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import 'react-native-reanimated';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: 'index',
};

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
    ...FontAwesome.font,
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) SplashScreen.hideAsync();
  }, [loaded]);

  if (!loaded) return null;

  return (
    <ThemeProvider value={DarkTheme}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#07080d' },
          headerTintColor: '#f4f4f8',
          contentStyle: { backgroundColor: '#07080d' },
        }}>
        <Stack.Screen name="index" options={{ title: 'spotBattle', headerShown: false }} />
        <Stack.Screen name="create" options={{ title: 'Create game' }} />
        <Stack.Screen name="join" options={{ title: 'Join game' }} />
        <Stack.Screen name="room/[code]" options={{ title: 'Room', headerBackTitle: 'Back' }} />
        <Stack.Screen name="party-deck/[code]" options={{ title: 'Party speaker', headerBackTitle: 'Back' }} />
        <Stack.Screen name="spotify-auth" options={{ title: 'Spotify' }} />
      </Stack>
    </ThemeProvider>
  );
}
