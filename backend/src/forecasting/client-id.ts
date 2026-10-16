import { createHash } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Deterministic UUID (version-5 layout) from a hash: the same input always gives the same id. */
export function uuidFromSha256(hex: string): string {
  const h = hex.slice(0, 32).split('');
  h[12] = '5';
  h[16] = ['8', '9', 'a', 'b'][Number.parseInt(h[16] as string, 16) % 4] as string;
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * Apps generate their own event ids and resend them on retry. Any id of 8-80 safe characters is accepted:
 * a real UUID is used as is, anything else is mapped to a stable UUID, so a repeat submit of the same id can
 * never create a second event while the database still stores a proper uuid.
 */
export function clientIdToUuid(clientId: string): string {
  if (UUID_RE.test(clientId)) return clientId.toLowerCase();
  return uuidFromSha256(createHash('sha256').update(`client-id:${clientId}`).digest('hex'));
}
