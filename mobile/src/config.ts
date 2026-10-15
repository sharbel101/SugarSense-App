// Only EXPO_PUBLIC_* variables are inlined into the bundle. See .env.example.
// The deployed web build sets EXPO_PUBLIC_WEB_SAME_ORIGIN=1 so API calls go to the page's own origin
// (nginx proxies /meals, /health, /glucose to the backend): no CORS, survives tunnel URL changes.
export const API_URL: string =
  process.env.EXPO_PUBLIC_WEB_SAME_ORIGIN === '1'
    ? ''
    : (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000');
