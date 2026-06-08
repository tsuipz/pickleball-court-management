import { computed, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { tapResponse } from '@ngrx/operators';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { filter, from, mergeMap, pipe, tap } from 'rxjs';
import { Player, PlayerId, SessionState } from '../models/types';
import * as rotation from '../services/rotation';
import { SessionService } from '../services/session.service';

/** Connection state of the live listener. */
export type ConnStatus = 'idle' | 'connecting' | 'live' | 'error';

/** Glanceable description of where the current player is right now. */
export type StatusKind = 'court' | 'queue' | 'challenger' | 'idle' | 'loading';
export interface PlayerStatus {
  kind: StatusKind;
  label: string;
  big: string;
  detail: string;
}

interface SessionUiState {
  /** Uppercased session code currently being watched. */
  code: string | null;
  /** Latest session document, or null while loading / when absent. */
  state: SessionState | null;
  /** Live-listener connection status. */
  conn: ConnStatus;
  /** Last user-facing error message, cleared when an action starts or succeeds. */
  error: string | null;
  /**
   * In-flight flags keyed by action + target (e.g. `join`, `activate:p3`,
   * `finishStandardGame:court-1`). Keyed per-target so two distinct targets
   * (benching yourself vs. bringing another player back) don't block each
   * other, while a repeat tap of the *same* action+target is dropped. Read in
   * templates via the coarse {@link SessionStore.busy} helper.
   */
  pending: Record<string, boolean>;
}

const initialState: SessionUiState = {
  code: null,
  state: null,
  conn: 'idle',
  error: null,
  pending: {},
};

/** How long to wait before re-attaching a dropped listener. */
const RECONNECT_DELAY_MS = 2000;

/**
 * The single client-side state + UX-orchestration layer for a session view.
 *
 * It owns one live `onSnapshot` listener (via {@link SessionService.listen}),
 * the shared view-model selectors that both the admin and player views read,
 * and per-action `pending`/`error` state. Every write still goes through the
 * Firestore transaction in {@link SessionService} — the store never reimplements
 * rotation rules; it just orchestrates the call, guards against double-taps with
 * `exhaustMap`, and surfaces failures.
 *
 * Provided at the route level (see `app.routes.ts`) so the listener is torn down
 * when the session view is left.
 */
export const SessionStore = signalStore(
  withState(initialState),

  withComputed((store, sessions = inject(SessionService)) => ({
    /** The current device's player id (reactive). */
    uid: computed(() => sessions.uid()),

    /** Standard queue as a view model: position + "is this me" flags. */
    queue: computed(() => {
      const s = store.state();
      const id = sessions.uid();
      if (!s) return [];
      return s.queue.map((pid, i) => ({
        id: pid,
        name: s.players[pid]?.name ?? '—',
        pos: i + 1,
        me: pid === id,
      }));
    }),

    /** Challenger queue as readable pair labels + "is this me" flags. */
    challengerPairs: computed(() => {
      const s = store.state();
      const id = sessions.uid();
      if (!s) return [];
      return s.challengerQueue.map((pair) => ({
        names: pair.playerIds
          .map((pid) => s.players[pid]?.name ?? '—')
          .join(' & '),
        me: !!id && pair.playerIds.includes(id),
      }));
    }),

    /** Players sitting out (benched). */
    benched: computed<Player[]>(() => {
      const s = store.state();
      return s ? rotation.benchedPlayers(s) : [];
    }),

    /** Whether the current device's player is in the session. */
    joined: computed(() => {
      const s = store.state();
      const id = sessions.uid();
      return !!s && !!id && !!s.players[id];
    }),

    /** Whether the current device owns (is admin of) this session. */
    isAdmin: computed(() => sessions.isAdmin(store.state())),

    /** The current player's own record, if they're playing. */
    me: computed<Player | null>(() => {
      const s = store.state();
      const id = sessions.uid();
      return s && id ? (s.players[id] ?? null) : null;
    }),

    /** Whether the current player is benched. */
    myResting: computed(() => {
      const s = store.state();
      const id = sessions.uid();
      return !!s && !!id && rotation.locatePlayer(s, id).kind === 'idle';
    }),

    /** The current player's display name, if joined. */
    myName: computed(() => {
      const s = store.state();
      const id = sessions.uid();
      return s && id ? (s.players[id]?.name ?? null) : null;
    }),

    /** Big, glanceable description of where the current player is. */
    status: computed<PlayerStatus>(() => {
      const s = store.state();
      const id = sessions.uid();
      if (!s || !id) return { kind: 'loading', label: '', big: '…', detail: '' };
      const loc = rotation.locatePlayer(s, id);
      switch (loc.kind) {
        case 'court':
          return {
            kind: 'court',
            label: "You're on",
            big: `Court ${loc.court.number}`,
            detail: 'Game on — have fun out there!',
          };
        case 'queue':
          return {
            kind: 'queue',
            label: loc.position === 1 ? "You're up next" : "You're in line",
            big: `#${loc.position}`,
            detail:
              loc.position === 1
                ? 'Head to the next open court'
                : `${loc.total} in the queue`,
          };
        case 'challenger-queue':
          return {
            kind: 'challenger',
            label: '🏆 Challenger queue',
            big: `#${loc.position}`,
            detail: 'Win and stay on the throne',
          };
        default:
          return {
            kind: 'idle',
            label: 'Sitting out',
            big: '☕',
            detail: 'Ask the organizer to add you back in',
          };
      }
    }),
  })),

  withMethods(
    (
      store,
      sessions = inject(SessionService),
      snack = inject(MatSnackBar),
    ) => {
      // Listener + reconnect state. The factory runs once per store instance.
      let unsub: (() => void) | null = null;
      let removeRecovery: (() => void) | null = null;
      let retry: ReturnType<typeof setTimeout> | null = null;

      const clearRetry = () => {
        if (retry) {
          clearTimeout(retry);
          retry = null;
        }
      };

      const detach = () => {
        clearRetry();
        unsub?.();
        unsub = null;
      };

      // (Re)attach the live listener. onSnapshot does not recover from an
      // initial permission error, so on any stream error we tear down and retry
      // — this is what makes the live view resilient to offline/auth hiccups.
      const attach = (code: string) => {
        detach();
        unsub = sessions.listen(
          code,
          (s) => patchState(store, { state: s, conn: 'live', error: null }),
          () => {
            patchState(store, {
              conn: 'error',
              error: 'Lost the live connection — reconnecting…',
            });
            clearRetry();
            retry = setTimeout(() => attach(code), RECONNECT_DELAY_MS);
          },
        );
      };

      const reattachIfDropped = () => {
        const code = store.code();
        if (code && store.conn() === 'error') attach(code);
      };

      const begin = (key: string) =>
        patchState(store, (s) => ({
          pending: { ...s.pending, [key]: true },
          error: null,
        }));
      const done = (key: string) =>
        patchState(store, (s) => ({ pending: { ...s.pending, [key]: false } }));
      const fail = (key: string, message: string) => (err: unknown) => {
        console.error(`[session] ${key} failed`, err);
        patchState(store, (s) => ({
          pending: { ...s.pending, [key]: false },
          error: message,
        }));
        snack.open(message, 'Dismiss', { duration: 4000 });
      };

      // Builds a guarded mutation. `keyOf` derives the action+target key:
      // a repeat of the same key while in flight is dropped (double-tap guard),
      // but `mergeMap` lets distinct keys run concurrently. Tracks per-key
      // pending and surfaces failures.
      const mutation = <T>(
        keyOf: (input: T) => string,
        run: (input: T) => Promise<void>,
        message: string,
      ) =>
        rxMethod<T>(
          pipe(
            filter((input) => !store.pending()[keyOf(input)]),
            tap((input) => begin(keyOf(input))),
            mergeMap((input) =>
              from(run(input)).pipe(
                tapResponse({
                  next: () => done(keyOf(input)),
                  error: fail(keyOf(input), message),
                }),
              ),
            ),
          ),
        );

      return {
        /** Start (or switch) the live listener for a session code. */
        connect(code: string): void {
          const c = code.toUpperCase();
          patchState(store, { code: c, conn: 'connecting', error: null });
          attach(c);
          if (!removeRecovery) {
            const onOnline = () => reattachIfDropped();
            const onVisible = () => {
              if (!document.hidden) reattachIfDropped();
            };
            window.addEventListener('online', onOnline);
            document.addEventListener('visibilitychange', onVisible);
            removeRecovery = () => {
              window.removeEventListener('online', onOnline);
              document.removeEventListener('visibilitychange', onVisible);
            };
          }
        },

        /** Tear down the listener + recovery handlers (called on destroy). */
        disconnect(): void {
          detach();
          removeRecovery?.();
          removeRecovery = null;
        },

        /**
         * Whether any in-flight action matches `action` (exact key or any
         * `action:target`). Used by templates to disable a control while its
         * action is running.
         */
        busy(action: string): boolean {
          const p = store.pending();
          return Object.keys(p).some(
            (k) => p[k] && (k === action || k.startsWith(`${action}:`)),
          );
        },

        join: mutation<{ code: string; name: string }>(
          () => 'join',
          ({ code, name }) => sessions.join(code, name),
          'Could not join the session.',
        ),
        rest: mutation<{ code: string; id?: PlayerId }>(
          ({ id }) => (id ? `rest:${id}` : 'rest'),
          ({ code, id }) => sessions.rest(code, id),
          'Could not take a break.',
        ),
        activate: mutation<{ code: string; id?: PlayerId }>(
          ({ id }) => (id ? `activate:${id}` : 'activate'),
          ({ code, id }) => sessions.activate(code, id),
          'Could not jump back in.',
        ),
        removePlayer: mutation<{ code: string; id: PlayerId }>(
          ({ id }) => `removePlayer:${id}`,
          ({ code, id }) => sessions.removePlayer(code, id),
          'Could not remove the player.',
        ),
        addCourt: mutation<{ code: string }>(
          () => 'addCourt',
          ({ code }) => sessions.addCourt(code),
          'Could not add a court.',
        ),
        removeCourt: mutation<{ code: string; courtId: string }>(
          ({ courtId }) => `removeCourt:${courtId}`,
          ({ code, courtId }) => sessions.removeCourt(code, courtId),
          'Could not remove the court.',
        ),
        setMode: mutation<{
          code: string;
          mode: SessionState['mode'];
          challengerCourtId?: string;
        }>(
          () => 'setMode',
          ({ code, mode, challengerCourtId }) =>
            sessions.setMode(code, mode, challengerCourtId),
          'Could not switch modes.',
        ),
        finishStandardGame: mutation<{
          code: string;
          courtId: string;
          opts?: rotation.StandardFinishOptions;
        }>(
          ({ courtId }) => `finishStandardGame:${courtId}`,
          ({ code, courtId, opts }) =>
            sessions.finishStandardGame(code, courtId, opts),
          'Could not finish the game.',
        ),
        finishChallengerGame: mutation<{
          code: string;
          courtId: string;
          winningPairIds: PlayerId[];
        }>(
          ({ courtId }) => `finishChallengerGame:${courtId}`,
          ({ code, courtId, winningPairIds }) =>
            sessions.finishChallengerGame(code, courtId, winningPairIds),
          'Could not finish the game.',
        ),
        reorderQueue: mutation<{ code: string; newQueue: PlayerId[] }>(
          () => 'reorderQueue',
          ({ code, newQueue }) => sessions.reorderQueue(code, newQueue),
          'Could not reorder the queue.',
        ),
        endSession: mutation<{ code: string }>(
          () => 'endSession',
          ({ code }) => sessions.endSession(code),
          'Could not end the session.',
        ),
      };
    },
  ),

  withHooks({
    onDestroy(store) {
      store.disconnect();
    },
  }),
);
