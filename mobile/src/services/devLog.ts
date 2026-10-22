/** Development-only logging (stripped from production: `__DEV__` is false there). Never log health values outside dev. */
declare const __DEV__: boolean;

export function devLog(label: string, data: Record<string, unknown>): void {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.log(`[dev] ${label}`, JSON.stringify(data));
  }
}
