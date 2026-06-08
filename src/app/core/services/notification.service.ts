import { Injectable } from '@angular/core';

/** localStorage key holding the "notify me" opt-in for a given session code. */
const enabledKey = (code: string) => `dink:notify:${code.toUpperCase()}`;

/**
 * Spark-plan-friendly "notify me when I'm up" via the Web Notifications API.
 *
 * There is no backend push: notifications are fired by the live Firestore
 * listener already running in the player view (see {@link PlayerPage}). This
 * works while the app is open — foreground OR backgrounded — which is the common
 * "phone in pocket, app still running" case, and is made far more reliable by
 * installing the PWA. It deliberately does NOT cover the fully-closed-app case:
 * that needs a trusted sender (Cloud Functions / a server, i.e. the Blaze plan)
 * and is out of scope. On iOS, web notifications require the PWA be installed
 * (Add to Home Screen, iOS ≥ 16.4).
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  /** Whether this browser exposes the Notifications API at all. */
  readonly supported =
    typeof Notification !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator;

  /** Current permission, or `'unsupported'` where the API is absent. */
  permission(): NotificationPermission | 'unsupported' {
    return this.supported ? Notification.permission : 'unsupported';
  }

  /** Whether the player has opted in for this session AND granted permission. */
  isEnabled(code: string): boolean {
    return (
      this.supported &&
      Notification.permission === 'granted' &&
      localStorage.getItem(enabledKey(code)) === '1'
    );
  }

  /**
   * Opt in for a session: request permission if needed and remember the choice.
   * Returns true when notifications are now enabled (permission granted).
   */
  async enable(code: string): Promise<boolean> {
    if (!this.supported) return false;
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm === 'granted') {
      localStorage.setItem(enabledKey(code), '1');
      return true;
    }
    return false;
  }

  /** Opt out for a session. */
  disable(code: string): void {
    if (this.supported) localStorage.removeItem(enabledKey(code));
  }

  /**
   * Show a notification. Prefers the service-worker registration's
   * `showNotification` (fires when the installed PWA is backgrounded and is the
   * only path that works on iOS), falling back to a page `Notification`.
   */
  async notify(title: string, body: string): Promise<void> {
    if (!this.supported || Notification.permission !== 'granted') return;
    const options: NotificationOptions = {
      body,
      tag: 'dink-turn',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
    };
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) {
        await reg.showNotification(title, options);
        return;
      }
    } catch {
      // fall through to the page-level Notification
    }
    try {
      new Notification(title, options);
    } catch {
      // some browsers forbid the constructor — nothing more we can do
    }
  }
}
