# spotBattle

Multiplayer party game: connect Spotify, join a room, and guess **whose** track is playing. Songs without a 30-second preview are skipped. **Deep cuts** mode only uses tracks that appear in exactly one player’s pool.

## Stack

- **Expo (React Native)** — iOS/Android/TestFlight
- **Supabase** — Postgres + Realtime + anonymous auth
- **Spotify** — Authorization Code with **PKCE** (no client secret in the app)

## Setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. **Authentication → Providers → Anonymous sign-in** — enable it.
3. Run the SQL in `supabase/migrations/20260429170000_init.sql` (SQL Editor or `supabase db push` if you use the CLI).
4. **Database → Replication** — enable realtime for `rooms` and `room_players` (or run the commented `alter publication` lines at the bottom of the migration file).

### 2. Spotify

1. [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) — create an app.
2. **Redirect URIs** — Spotify requires an **exact** match. Since **April 2025**, new apps disallow **`localhost`**; use a **loopback literal** for local HTTP ([Spotify blog](https://developer.spotify.com/blog/2025-02-12-increasing-the-security-requirements-for-integrating-with-spotify)).

   - **Development build / TestFlight / production** (not Expo Go):  
     `spotbattle://spotify-auth`
   - **Expo Go**: something like `exp://192.168.x.x:8081/--/spotify-auth` — the room lobby shows the exact string to add.
   - **Web** (`expo start --web`): this app uses **`http://127.0.0.1:PORT/spotify-auth`** (not `localhost`). Open the dev server at **`http://127.0.0.1:8081`** (or match your Metro port) and add that exact URI in Spotify. For dynamic ports on loopback, follow Spotify’s “register without port” rule if you need it.

3. Copy the **Client ID** (PKCE public clients do not use a client secret in the app).

### 3. Environment

Copy `.env.example` to `.env` in the project root and fill in:

- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`
- `EXPO_PUBLIC_SPOTIFY_CLIENT_ID`

Restart Expo after changing env vars (`npx expo start -c`).

## Deploy web (Vercel)

The repo includes `vercel.json`: **Other / no framework**, `npm run build` → `expo export --platform web`, publish **`dist`**, and SPA rewrites so routes like `/room/ABCD` work after refresh. `.nvmrc` pins **Node 20** (Expo’s Metro needs Node 20+).

1. Commit and push these files, then redeploy (or `npx vercel --prod`).
2. In the Vercel project → **Settings → Environment Variables**, set `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, and `EXPO_PUBLIC_SPOTIFY_CLIENT_ID` for **Production** (and **Preview** if you use preview URLs).
3. Confirm the latest deployment **Build** logs show a successful export and that **Output** is `dist` (you should see `index.html` in the build output).
4. **Spotify**: add your live redirect URI (usually `https://<your-domain>/spotify-auth`) — copy the exact string from the in-app lobby if unsure.

If you see **404: NOT_FOUND** on the Vercel URL, the usual cause is an **empty or wrong output directory** (build never ran `expo export`, or Vercel used a different preset). Fix: ensure this `vercel.json` is deployed, **Node 20.x** in project settings, env vars set, then **Redeploy**.

## Run locally

```bash
npm install
npx expo start
```

Use two devices or a simulator + phone to test host + joiner.

## App Store / TestFlight

1. **Apple Developer** — enroll the program.
2. **Expo Application Services** — `npm i -g eas-cli`, `eas login`, `eas build:configure`.
3. In `app.json`, set `ios.bundleIdentifier` to your reverse-DNS id (e.g. `com.yourcompany.spotbattle`).
4. `eas build --platform ios` then submit the artifact to App Store Connect and enable **TestFlight** for internal testers.

Spotify’s terms require compliant use of their APIs and branding; review [Spotify Developer Policy](https://developer.spotify.com/policy) before shipping.

## Privacy (MVP)

Track pools are stored only for active games as JSON on `room_players` and should be treated as ephemeral party session data. Remove or purge old rooms in production if you need stricter retention.
