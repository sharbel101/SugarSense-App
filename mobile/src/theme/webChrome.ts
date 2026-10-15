/**
 * Web only: keeps the page-level chrome that sits outside the React tree in step with the theme
 * the app is actually showing. On a phone that chrome is the status-bar / Dynamic Island strip,
 * which iOS and Android tint from the `theme-color` meta tag - the OS appearance alone isn't enough
 * because the user can force Light or Dark in Profile & settings. A no-op off the web.
 */
export function syncWebChrome(scheme: 'light' | 'dark', ground: string): void {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  root.style.colorScheme = scheme;
  root.style.backgroundColor = ground;
  if (document.body) document.body.style.backgroundColor = ground;

  // Collapse the media-query pair from public/index.html into one tag. With several tags the
  // browser picks the first whose media query matches, which would ignore a forced theme.
  const tags = Array.from(document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
  const meta = tags[0] ?? document.head.appendChild(Object.assign(document.createElement('meta'), { name: 'theme-color' }));
  tags.slice(1).forEach((extra) => extra.remove());
  meta.removeAttribute('media');
  meta.content = ground;
}
