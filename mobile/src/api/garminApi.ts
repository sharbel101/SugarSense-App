import { Platform } from 'react-native';
import { API_URL } from '../config';
import type { GarminConfig } from './garminContract';
import { ngrokBypassHeaders } from './requestHeaders';

export * from './garminContract';

/**
 * Where the Garmin API is and the token to send. `EXPO_PUBLIC_GARMIN_API_URL` is the full base
 * (`https://host/api/garmin/v1`); on the web build served from the VM the same-origin path works without it.
 * The token only keeps scanners out (it is inlined in a web bundle, so it is NOT a secret): never commit it.
 * Returns `null` when no URL or no token is set, and the screen then stays on its labelled demo data.
 */
export function garminConfig(): GarminConfig | null {
  const url = process.env.EXPO_PUBLIC_GARMIN_API_URL;
  const token = process.env.EXPO_PUBLIC_GARMIN_API_TOKEN;
  const baseUrl = url ? url.replace(/\/+$/, '') : Platform.OS === 'web' && API_URL === '' ? '/api/garmin/v1' : null;
  if (!baseUrl || !token) return null;
  return { baseUrl, token, extraHeaders: ngrokBypassHeaders(baseUrl) };
}
