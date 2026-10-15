import { API_URL } from '../config';
import { ngrokBypassHeaders } from './requestHeaders';

export type HealthResponse = { status: string };

/** Calls the backend liveness probe. Throws if the server is unreachable or answers non-2xx. */
export async function getHealth(): Promise<HealthResponse> {
  const response = await fetch(`${API_URL}/health`, { headers: ngrokBypassHeaders(API_URL) });
  if (!response.ok) {
    throw new Error(`Backend responded with HTTP ${response.status}`);
  }
  return (await response.json()) as HealthResponse;
}
