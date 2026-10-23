import { sileo } from 'sileo';
import type { ToastSpec } from './toastText';

/** Web (a Safari tab, the home-screen web app, a desktop browser): toasts drawn by Sileo. */
let enabled = true;
const live = new Map<string, string>();

export function setToastsEnabled(on: boolean): void {
  enabled = on;
  if (!on) sileo.clear();
}

/** One toast per `key` at a time: a newer one of the same kind replaces the older instead of stacking. */
export function showToast(spec: ToastSpec): void {
  if (!enabled) return;
  const previous = live.get(spec.key);
  if (previous) sileo.dismiss(previous);
  const opts = { title: spec.title, description: spec.description, duration: spec.durationMs ?? 5000 };
  const id =
    spec.tone === 'success' ? sileo.success(opts) : spec.tone === 'warning' ? sileo.warning(opts) : spec.tone === 'error' ? sileo.error(opts) : sileo.info(opts);
  live.set(spec.key, id);
}
