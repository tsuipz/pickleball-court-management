import { Injectable, signal } from '@angular/core';
import { FirebaseApp, initializeApp } from 'firebase/app';
import {
  Auth,
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
} from 'firebase/auth';
import {
  Firestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';
import { environment } from '../../../environments/environment';

/**
 * Owns the Firebase app, Firestore handle, and anonymous auth identity.
 *
 * Firestore is initialized with:
 *  - `experimentalAutoDetectLongPolling` — Safari's WebChannel/ITP handling can
 *    stall the realtime `Listen` channel; auto-detect falls back to long
 *    polling so the stream opens promptly.
 *  - a persistent (IndexedDB) local cache — repeat loads hydrate instantly from
 *    cache while the network catches up, so the UI is not blank on open.
 *
 * `init()` kicks off anonymous sign-in WITHOUT blocking app bootstrap (the
 * Firestore SDK holds listens until the auth token is ready), so first paint is
 * not gated on a network round-trip.
 */
@Injectable({ providedIn: 'root' })
export class FirebaseService {
  private readonly app: FirebaseApp = initializeApp(environment.firebase);
  readonly auth: Auth = getAuth(this.app);
  readonly db: Firestore = initializeFirestore(this.app, {
    experimentalAutoDetectLongPolling: true,
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager(),
    }),
  });

  /** The current anonymous user's uid, or null until auth resolves. */
  readonly uid = signal<string | null>(null);

  /** Fire-and-forget: start anonymous sign-in and track the uid. */
  init(): void {
    onAuthStateChanged(this.auth, (user) => {
      if (user) this.uid.set(user.uid);
    });
    signInAnonymously(this.auth).catch((err) => {
      console.error('Anonymous sign-in failed', err);
    });
  }
}
