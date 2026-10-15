/**
 * Web only: lets a deployed build replace itself when a newer one is live.
 *
 * Why this exists: an iOS home-screen web app is resumed from memory instead of reloaded, and keeps
 * its own saved copy of the page, so it can sit on an old bundle indefinitely while Safari (which
 * reloads normally) shows the new one. The server cannot push a reload, so the page asks.
 *
 * An exported build names its script `/_expo/static/js/web/<name>-<content hash>.js`, so "is there a
 * newer build" is just "does the page the server would send now point at a different script".
 * Does nothing on the dev server (its bundle URL has no hash) or off the web.
 */

const BUNDLE_RE = /\/_expo\/static\/js\/web\/[\w.-]+\.js/;
const RELOADED_FOR_KEY = 'sugarsense.web-update.reloaded-for';
/** Looking again right after launch catches a stale saved copy of the page on a cold start. */
const FIRST_CHECK_DELAY_MS = 2000;
/** Coming back sooner than this is a glance at another app, not a fresh session: don't reload. */
const RESUME_AFTER_MS = 60_000;

/** The bundle path a served `index.html` points at, or null if it has none. */
export function bundlePathFromHtml(html: string): string | null {
  return html.match(BUNDLE_RE)?.[0] ?? null;
}

/**
 * Reload only when both paths are known, they differ, and we have not already reloaded for this
 * target - so a page the server keeps serving stale (or a cache that ignores us) can never loop.
 */
export function shouldReload(current: string | null, latest: string | null, reloadedFor: string | null): boolean {
  return current !== null && latest !== null && current !== latest && latest !== reloadedFor;
}

function readReloadedFor(): string | null {
  try {
    return sessionStorage.getItem(RELOADED_FOR_KEY);
  } catch {
    return null;
  }
}

function writeReloadedFor(path: string): void {
  try {
    sessionStorage.setItem(RELOADED_FOR_KEY, path);
  } catch {
    // Storage blocked: the worst case is one extra reload attempt next time, not a loop.
  }
}

/** Starts the watcher; returns a function that stops it. Safe to call anywhere. */
export function startWebUpdateWatcher(): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {};

  const script = document.querySelector<HTMLScriptElement>('script[src*="/_expo/static/js/web/"]');
  const current = script ? new URL(script.src).pathname : null;
  if (current === null) return () => {};

  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      // `reload` bypasses the saved copy AND refreshes it, so the location.reload() below reads the
      // new page instead of the stale one it would otherwise consider still fresh.
      const res = await fetch('/', { cache: 'reload', headers: { Accept: 'text/html' } });
      if (!res.ok) return;
      const latest = bundlePathFromHtml(await res.text());
      if (latest !== null && shouldReload(current, latest, readReloadedFor())) {
        writeReloadedFor(latest);
        window.location.reload();
      }
    } catch {
      // Offline or the request failed: try again at the next resume.
    } finally {
      checking = false;
    }
  };

  let hiddenAt: number | null = null;
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
    } else if (hiddenAt !== null && Date.now() - hiddenAt >= RESUME_AFTER_MS) {
      hiddenAt = null;
      void check();
    }
  };

  const firstCheck = setTimeout(() => void check(), FIRST_CHECK_DELAY_MS);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    clearTimeout(firstCheck);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
