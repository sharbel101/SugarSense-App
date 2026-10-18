import { Platform } from 'react-native';
import type { AlertNotification } from './riskAlerts';

/**
 * Alerts for the web app (a Safari tab, a home-screen web app, a desktop browser). Not used on the
 * native builds. Notifications are shown through the service worker (`public/sw.js`), because that
 * is the only way a home-screen web app on iPhone can show one.
 *
 * What this does NOT do: send an alert while the app is closed or the phone has suspended it. These
 * alerts are raised by the app itself when a new forecast arrives, so they arrive while the app is
 * open. Alerts for a closed app need the server to send a web push (see the backend request).
 */

export type AlertPermission = 'unsupported' | 'default' | 'granted' | 'denied';

type NotificationLike = {
  new (title: string, options?: Record<string, unknown>): unknown;
  permission: 'default' | 'granted' | 'denied';
  requestPermission: () => Promise<'default' | 'granted' | 'denied'>;
};
type RegistrationLike = {
  showNotification: (title: string, options: Record<string, unknown>) => Promise<void>;
};
type ServiceWorkerContainerLike = {
  register: (url: string) => Promise<RegistrationLike>;
  getRegistration: () => Promise<RegistrationLike | undefined>;
};

function notificationApi(): NotificationLike | null {
  if (Platform.OS !== 'web') return null;
  const n = (globalThis as { Notification?: NotificationLike }).Notification;
  return n ?? null;
}

function serviceWorkerApi(): ServiceWorkerContainerLike | null {
  if (Platform.OS !== 'web') return null;
  const nav = (globalThis as { navigator?: { serviceWorker?: ServiceWorkerContainerLike } }).navigator;
  return nav?.serviceWorker ?? null;
}

/** `unsupported` on the native apps and in browsers without notifications (a plain iPhone Safari tab). */
export function alertPermission(): AlertPermission {
  const n = notificationApi();
  if (!n || !serviceWorkerApi()) return 'unsupported';
  return n.permission;
}

async function registration(): Promise<RegistrationLike | null> {
  const sw = serviceWorkerApi();
  if (!sw) return null;
  try {
    return (await sw.getRegistration()) ?? (await sw.register('/sw.js'));
  } catch {
    return null;
  }
}

/** Asks the browser for permission (it only shows the question from a tap). The answer is remembered by the browser. */
export async function requestAlertPermission(): Promise<AlertPermission> {
  const n = notificationApi();
  if (!n || !serviceWorkerApi()) return 'unsupported';
  try {
    if (n.permission === 'default') await n.requestPermission();
  } catch {
    // an old browser that wants a callback: fall through to the permission it now reports
  }
  if (n.permission === 'granted') await registration();
  return n.permission;
}

/** Shows one alert; false when nothing could be shown. */
export async function showAlert(alert: AlertNotification): Promise<boolean> {
  if (alertPermission() !== 'granted') return false;
  // The same tag replaces the earlier alert; renotify makes the replacement alert again.
  const options = { body: alert.body, tag: alert.tag, renotify: true, icon: '/icon.png', badge: '/icon.png', data: { url: '/' } };
  const reg = await registration();
  if (reg) {
    try {
      await reg.showNotification(alert.title, options);
      return true;
    } catch {
      // fall through to the plain notification below
    }
  }
  // No service worker (an embedded browser, some desktop setups): a plain notification still works there.
  try {
    const Ctor = notificationApi();
    if (!Ctor) return false;
    new Ctor(alert.title, options);
    return true;
  } catch {
    return false;
  }
}
