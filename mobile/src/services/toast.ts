import type { ToastSpec } from './toastText';

/**
 * Native builds: no toast library draws here (Sileo is a web component), so this does nothing. Every event that
 * toasts on the web is still shown by its own screen (the saved message, the forecast, the alert cards).
 * The web version is `toast.web.ts`.
 */
export function showToast(_spec: ToastSpec): void {
  void _spec;
}

export function setToastsEnabled(_on: boolean): void {
  void _on;
}
