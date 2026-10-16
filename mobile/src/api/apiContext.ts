import { API_URL } from '../config';
import type { ApiContext } from './eventsApi';
import { fetchForecastFrom, type ForecastFetchOutcome } from './forecastContract';
import { ngrokBypassHeaders } from './requestHeaders';

/**
 * Transport headers for the forecast / event / therapy routes: the ngrok bypass (only when the base
 * URL is an ngrok domain) and, only when it is set, `X-App-Token`. The server enforces the token only
 * when its owner turns that on. A token in a web bundle is NOT a secret (anyone can read it), so this
 * is bot protection, not security - never describe it as protecting health data.
 */
export function transportHeaders(baseUrl: string = API_URL): Record<string, string> {
  const token = process.env.EXPO_PUBLIC_APP_API_TOKEN;
  return { ...ngrokBypassHeaders(baseUrl), ...(token ? { 'X-App-Token': token } : null) };
}

export const apiContext: ApiContext = { baseUrl: API_URL, headers: transportHeaders() };

/** `GET ${API_URL}/forecast`. */
export function fetchForecast(signal?: AbortSignal): Promise<ForecastFetchOutcome> {
  return fetchForecastFrom(API_URL, signal, fetch, transportHeaders());
}
