import { API_URL } from '../config';
import { transportHeaders } from './apiContext';
import { fetchInsightsFrom, type InsightsFetchOutcome } from './insightsContract';

export * from './insightsContract';

/** `GET ${API_URL}/insights` (same origin on the deployed web build, where API_URL is ''). */
export function fetchInsights(signal?: AbortSignal): Promise<InsightsFetchOutcome> {
  return fetchInsightsFrom(API_URL, signal, undefined, transportHeaders());
}
