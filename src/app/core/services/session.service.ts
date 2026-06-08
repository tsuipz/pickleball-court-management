import { Injectable, Injector, effect, inject } from '@angular/core';
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
 * a pure rotation function inside a transaction.
 *
 * This is a thin Firebase data layer: it does not hold the live state or surface
 * gameplay errors itself. `listen()` hands snapshots to a callback and `mutate()`
 * rethrows on failure — the {@link SessionStore} owns the live signal, the
 * per-action pending/error state, and the user-facing messaging.
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

  /**
   * Create a session: generate a join code + admin token, write the initial
   * state, and remember the token on this device so this browser stays admin.
   * Returns the join code. If `adminName` is given the organizer also joins the
   * queue as a player.
   */
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
   * Low-level live listener for a session document. Calls `onState` with each
   * Firestore snapshot (null if the doc is absent) and `onError` if the stream
   * errors. Returns an unsubscribe function — the caller (the
   * {@link SessionStore}) owns teardown and any reconnect policy.
   *
   * Firestore reads require an auth token, and `onSnapshot` does NOT recover
   * from an initial permission error — so the listener is held until anonymous
   * sign-in has landed (keeps first paint instant without a permission error).
   */
  listen(
    code: string,
    onState: (s: SessionState | null) => void,
    onError: (err: unknown) => void,
  ): () => void {
    const ref = this.ref(code);
    let unsub: (() => void) | null = null;
    let pending: { destroy: () => void } | null = null;

    const attach = () => {
      if (unsub) return;
      unsub = onSnapshot(
        ref,
        (snap) =>
          onState(snap.exists() ? (snap.data() as SessionState) : null),
        (err) => onError(err),
      );
    };

    if (this.fb.uid()) {
      attach();
    } else {
      pending = effect(
        () => {
          if (this.fb.uid()) attach();
        },
        { injector: this.injector },
      );
    }

    return () => {
      pending?.destroy();
      unsub?.();
    };
  }

  /** Whether the current device's uid owns the given session. */
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
  // Every gameplay change below funnels through mutate(): the methods are thin
  // wrappers that name the corresponding pure rotation function. Game rules live
  // in rotation.ts, not here.

  /**
   * Apply a pure rotation function to the session inside a Firestore
   * transaction (read current doc → transform → write whole doc back), so
   * concurrent admin/player edits can't clobber each other. Rejects on failure;
   * the {@link SessionStore} catches it to drive per-action error state.
   */
  private async mutate(
    code: string,
    apply: (s: SessionState) => SessionState,
  ): Promise<void> {
    const ref = this.ref(code);
    await runTransaction(this.fb.db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('Session not found.');
      tx.set(ref, apply(snap.data() as SessionState));
    });
  }

  /** Join (or rename) the current player into the session's queue. */
  join(code: string, name: string): Promise<void> {
    const uid = this.fb.uid();
    if (!uid) return Promise.reject(new Error('Not connected yet.'));
    return this.mutate(code, (s) =>
      rotation.addPlayer(s, uid, name.trim(), Date.now()),
    );
  }

  /** Bench a player (defaults to the current player) — they leave rotation but
   *  stay in the session. */
  rest(code: string, id = this.fb.uid()): Promise<void> {
    if (!id) return Promise.resolve();
    return this.mutate(code, (s) => rotation.restPlayer(s, id));
  }

  /** Bring a benched player back into the queue (defaults to the current player). */
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
