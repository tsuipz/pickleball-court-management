import {
  DestroyRef,
  Injectable,
  Injector,
  Signal,
  effect,
  inject,
  signal,
} from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import {
  DocumentReference,
  doc,
  onSnapshot,
  runTransaction,
  setDoc,
} from 'firebase/firestore';
import { SessionState } from '../models/types';
import { FirebaseService } from './firebase.service';
import * as rotation from './rotation';

/** Characters used for codes/tokens — no ambiguous 0/O/1/I. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const TOKEN_LENGTH = 24;

/** localStorage key holding the admin token for a given session code. */
const adminKey = (code: string) => `dink:admin:${code.toUpperCase()}`;

/**
 * Reads and writes the single-document session state in Firestore.
 *
 * The whole session lives in one document (`sessions/{code}`) so that every
 * rotation is an atomic transaction and a single `onSnapshot` listener drives
 * the live UI. All gameplay mutations funnel through `mutate()`, which applies
 * a pure rotation function inside a transaction and surfaces failures.
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly fb = inject(FirebaseService);
  private readonly snack = inject(MatSnackBar);
  private readonly injector = inject(Injector);

  /** The current player's uid (reactive). */
  readonly uid = this.fb.uid;

  private ref(code: string): DocumentReference {
    return doc(this.fb.db, 'sessions', code.toUpperCase());
  }

  async createSession(
    name: string,
    courtCount: number,
    adminName?: string,
  ): Promise<string> {
    const uid = this.fb.uid();
    if (!uid) throw new Error('Not authenticated yet.');
    const code = this.randomString(CODE_LENGTH);
    const adminToken = this.randomString(TOKEN_LENGTH);
    const state = rotation.createInitialSessionState({
      code,
      name: name.trim() || 'Pickleball Session',
      adminUid: uid,
      adminToken,
      courtCount,
      createdAt: Date.now(),
      adminName,
    });
    try {
      await setDoc(this.ref(code), state);
    } catch (err) {
      this.report(err, 'Could not create the session.');
      throw err;
    }
    localStorage.setItem(adminKey(code), adminToken);
    return code;
  }

  /**
   * Live view of a session. Returns a signal that updates on every Firestore
   * change; the listener is torn down when the calling context is destroyed.
   */
  watch(code: string, destroyRef: DestroyRef): Signal<SessionState | null> {
    const state = signal<SessionState | null>(null);
    const ref = this.ref(code);
    let unsub: (() => void) | null = null;

    const attach = () => {
      if (unsub) return;
      unsub = onSnapshot(
        ref,
        (snap) =>
          state.set(snap.exists() ? (snap.data() as SessionState) : null),
        (err) => console.error('Session listener error', err),
      );
    };

    // Firestore reads require an auth token, and onSnapshot does NOT recover
    // from an initial permission error — so wait until anonymous sign-in has
    // landed before attaching the listener (keeps first paint instant).
    if (this.fb.uid()) {
      attach();
    } else {
      const ref2 = effect(
        () => {
          if (this.fb.uid()) attach();
        },
        { injector: this.injector },
      );
      destroyRef.onDestroy(() => ref2.destroy());
    }
    destroyRef.onDestroy(() => unsub?.());
    return state;
  }

  isAdmin(state: SessionState | null): boolean {
    return !!state && state.adminUid === this.fb.uid();
  }

  // --- Admin recovery / hand-off -----------------------------------------

  /** The token this device holds for a session, if any. */
  storedAdminToken(code: string): string | null {
    return localStorage.getItem(adminKey(code));
  }

  /** A shareable link that lets another device claim the admin role. */
  adminLink(code: string): string | null {
    const token = this.storedAdminToken(code);
    if (!token) return null;
    return `${location.origin}/session/${code.toUpperCase()}/admin?t=${token}`;
  }

  /**
   * Attempt to (re)claim the admin role with a token. Used when an admin
   * returns on a new device via the transfer link. Returns true on success.
   */
  async claimAdmin(code: string, token: string | null): Promise<boolean> {
    const uid = this.fb.uid();
    if (!uid || !token) return false;
    const ref = this.ref(code);
    let ok = false;
    try {
      await runTransaction(this.fb.db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) return;
        const s = snap.data() as SessionState;
        if (s.adminToken && s.adminToken === token) {
          tx.update(ref, { adminUid: uid });
          ok = true;
        }
      });
    } catch (err) {
      this.report(err, 'Could not claim admin.');
      return false;
    }
    if (ok) localStorage.setItem(adminKey(code), token);
    return ok;
  }

  // --- Mutations ----------------------------------------------------------

  private async mutate(
    code: string,
    apply: (s: SessionState) => SessionState,
    failureMessage = 'Something went wrong — please try again.',
  ): Promise<void> {
    const ref = this.ref(code);
    try {
      await runTransaction(this.fb.db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error('Session not found.');
        tx.set(ref, apply(snap.data() as SessionState));
      });
    } catch (err) {
      this.report(err, failureMessage);
    }
  }

  join(code: string, name: string): Promise<void> {
    const uid = this.fb.uid();
    if (!uid) {
      this.report(null, 'Not connected yet — try again in a moment.');
      return Promise.resolve();
    }
    return this.mutate(
      code,
      (s) => rotation.addPlayer(s, uid, name.trim(), Date.now()),
      'Could not join the session.',
    );
  }

  /** Current player sits out / comes back / leaves. */
  rest(code: string, id = this.fb.uid()): Promise<void> {
    if (!id) return Promise.resolve();
    return this.mutate(code, (s) => rotation.restPlayer(s, id));
  }

  activate(code: string, id = this.fb.uid()): Promise<void> {
    if (!id) return Promise.resolve();
    return this.mutate(code, (s) => rotation.activatePlayer(s, id));
  }

  removePlayer(code: string, id: string): Promise<void> {
    return this.mutate(code, (s) => rotation.removePlayer(s, id));
  }

  addCourt(code: string): Promise<void> {
    return this.mutate(code, (s) => rotation.addCourt(s));
  }

  removeCourt(code: string, courtId: string): Promise<void> {
    return this.mutate(code, (s) => rotation.removeCourt(s, courtId));
  }

  setMode(
    code: string,
    mode: SessionState['mode'],
    challengerCourtId?: string,
  ): Promise<void> {
    return this.mutate(code, (s) =>
      rotation.setMode(s, mode, challengerCourtId),
    );
  }

  finishStandardGame(
    code: string,
    courtId: string,
    opts: rotation.StandardFinishOptions = {},
  ): Promise<void> {
    return this.mutate(code, (s) =>
      rotation.finishStandardGame(s, courtId, opts),
    );
  }

  finishChallengerGame(
    code: string,
    courtId: string,
    winningPairIds: string[],
  ): Promise<void> {
    return this.mutate(code, (s) =>
      rotation.finishChallengerGame(s, courtId, winningPairIds),
    );
  }

  reorderQueue(code: string, newQueue: string[]): Promise<void> {
    return this.mutate(code, (s) => rotation.reorderQueue(s, newQueue));
  }

  endSession(code: string): Promise<void> {
    return this.mutate(code, (s) => rotation.endSession(s));
  }

  private report(err: unknown, message: string): void {
    if (err) console.error(message, err);
    this.snack.open(message, 'Dismiss', { duration: 4000 });
  }

  private randomString(length: number): string {
    let out = '';
    const bytes = new Uint32Array(length);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < length; i++) {
      out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return out;
  }
}
