/**
 * ngrok's free tier answers browser requests with an HTML warning page (`ERR_NGROK_6024`) that has no
 * CORS headers, so a web page calling the VM through its ngrok tunnel sees a CORS failure and the
 * app reports "not available". The warning is skipped when this header is present.
 *
 * It is only needed - and so only sent - when the base URL is an ngrok domain, i.e. local web dev
 * against the tunnel. Native fetch never receives the warning page, and the deployed web build is
 * same-origin (base URL ''), so neither of them pays for the extra CORS preflight a custom header
 * causes.
 */
export function ngrokBypassHeaders(baseUrl: string): Record<string, string> {
  return /ngrok[^/]*\.(dev|app|io)/i.test(baseUrl) ? { 'ngrok-skip-browser-warning': 'true' } : {};
}
