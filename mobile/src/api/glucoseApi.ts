import { API_URL } from '../config';
import { fetchGlucoseFrom, type GlucoseFetchOutcome } from './glucoseContract';

export * from './glucoseContract';

/** `GET ${API_URL}/glucose` (same origin on the deployed web build, where API_URL is ''). */
export function fetchGlucose(signal?: AbortSignal): Promise<GlucoseFetchOutcome> {
  return fetchGlucoseFrom(API_URL, signal);
}
