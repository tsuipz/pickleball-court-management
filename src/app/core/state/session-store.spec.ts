import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { vi } from 'vitest';
import { SessionState } from '../models/types';
import {
  addPlayer,
  createInitialSessionState,
  finishStandardGame,
  restPlayer,
  setMode,
} from '../services/rotation';
import { SessionService } from '../services/session.service';
import { SessionStore } from './session-store';

/** Flush pending microtasks + timers so promise-based mutations settle. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Real-signal stand-in for the SessionService data layer (no Firestore). It
 * captures the live `listen` callbacks so a test can push state/errors, and its
 * mutators return controllable promises so we can assert in-flight `pending`.
 */
class FakeSessions {
  readonly uid = signal<string | null>('admin');
  private latest: SessionState | null = null;
  private onState: ((s: SessionState | null) => void) | null = null;
  private onError: ((e: unknown) => void) | null = null;
  listenCount = 0;
  unsubCount = 0;
  calls: unknown[][] = [];
  /** Resolvers for in-flight mutation promises; call flush() to settle them. */
  private resolvers: Array<() => void> = [];
  rejectNext = false;

  /** Preset the doc returned to the next listener (before connect). */
  preset(s: SessionState | null) {
    this.latest = s;
  }
  /** Push a new snapshot to the live listener. */
  emit(s: SessionState | null) {
    this.latest = s;
    this.onState?.(s);
  }
  /** Drive the listener's error path. */
  emitError(e: unknown) {
    this.onError?.(e);
  }

  listen(
    _code: string,
    onState: (s: SessionState | null) => void,
    onError: (e: unknown) => void,
  ): () => void {
    this.listenCount++;
    this.onState = onState;
    this.onError = onError;
    onState(this.latest);
    return () => {
      this.unsubCount++;
      this.onState = null;
      this.onError = null;
    };
  }

  isAdmin(s: SessionState | null) {
    return !!s && s.adminUid === this.uid();
  }

  private rec =
    (name: string) =>
    (...args: unknown[]): Promise<void> => {
      this.calls.push([name, ...args]);
      if (this.rejectNext) {
        this.rejectNext = false;
        return Promise.reject(new Error('boom'));
      }
      return new Promise<void>((resolve) => this.resolvers.push(resolve));
    };

  join = this.rec('join');
  rest = this.rec('rest');
  activate = this.rec('activate');
  removePlayer = this.rec('removePlayer');
  addCourt = this.rec('addCourt');
  removeCourt = this.rec('removeCourt');
  setMode = this.rec('setMode');
  finishStandardGame = this.rec('finishStandardGame');
  finishChallengerGame = this.rec('finishChallengerGame');
  reorderQueue = this.rec('reorderQueue');
  endSession = this.rec('endSession');

  /** Settle every outstanding mutation promise. */
  flush() {
    const pending = this.resolvers;
    this.resolvers = [];
    pending.forEach((resolve) => resolve());
  }
  countOf(name: string) {
    return this.calls.filter((c) => c[0] === name).length;
  }
}

function buildState(playerCount: number, courtCount = 1): SessionState {
  let s = createInitialSessionState({
    code: 'TEST1',
    name: 'Test',
    adminUid: 'admin',
    adminToken: 'tok',
    courtCount,
    createdAt: 0,
  });
  for (let i = 1; i <= playerCount; i++) {
    s = addPlayer(s, `p${i}`, `Player ${i}`, i);
  }
  return s;
}

function makeStore(uid: string | null = 'admin') {
  const fake = new FakeSessions();
  fake.uid.set(uid);
  TestBed.configureTestingModule({
    providers: [
      SessionStore,
      { provide: SessionService, useValue: fake },
      { provide: MatSnackBar, useValue: { open: () => {} } },
    ],
  });
  const store = TestBed.inject(SessionStore);
  return { store, fake };
}

/** A store already connected and live with the given session state. */
function makeLive(state: SessionState | null, uid: string | null = 'admin') {
  const { store, fake } = makeStore(uid);
  fake.preset(state);
  store.connect('test1');
  return { store, fake };
}

describe('SessionStore connection', () => {
  it('starts idle and goes connecting → live on connect', () => {
    const { store, fake } = makeStore();
    expect(store.conn()).toBe('idle');
    fake.preset(buildState(2));
    store.connect('test1');
    expect(store.conn()).toBe('live');
    expect(store.code()).toBe('TEST1');
    expect(store.state()?.name).toBe('Test');
  });

  it('drops into error and arms a reconnect when the listener errors', () => {
    const { store, fake } = makeLive(buildState(2));
    expect(fake.listenCount).toBe(1);
    fake.emitError(new Error('permission-denied'));
    expect(store.conn()).toBe('error');
    expect(store.error()).toContain('Lost the live connection');
    store.disconnect(); // clear the armed retry timer
  });

  it('updates state on each live snapshot', () => {
    const { store, fake } = makeLive(buildState(2)); // 2 players wait (court needs 4)
    expect(store.queue().map((q) => q.id)).toEqual(['p1', 'p2']);
    fake.emit(buildState(6)); // court fills with p1-4; p5,p6 wait
    expect(store.queue().map((q) => q.id)).toEqual(['p5', 'p6']);
  });
});

describe('SessionStore selectors', () => {
  it('maps the queue with position + "me" flags', () => {
    const { store } = makeLive(buildState(6), 'p5');
    expect(store.queue()).toEqual([
      { id: 'p5', name: 'Player 5', pos: 1, me: true },
      { id: 'p6', name: 'Player 6', pos: 2, me: false },
    ]);
  });

  it('derives benched, joined, isAdmin and player status', () => {
    let s = buildState(3);
    s = restPlayer(s, 'p1');
    const { store } = makeLive(s, 'p1');
    expect(store.benched().map((p) => p.id)).toContain('p1');
    expect(store.joined()).toBe(true);
    expect(store.isAdmin()).toBe(false);
    expect(store.status().kind).toBe('idle');
  });

  it('labels promoted challenger pairs', () => {
    let s = buildState(8, 2);
    s = setMode(s, 'challenger', 'court-1');
    s = finishStandardGame(s, 'court-2', {
      winningPairIds: ['p5', 'p6'],
      promote: true,
    });
    const { store } = makeLive(s, 'p5');
    expect(store.challengerPairs()).toEqual([
      { names: 'Player 5 & Player 6', me: true },
    ]);
  });
});

describe('SessionStore mutations', () => {
  it('forwards to the service with positional args and tracks pending', async () => {
    const { store, fake } = makeLive(buildState(4));
    store.setMode({ code: 'TEST1', mode: 'challenger', challengerCourtId: 'court-1' });
    expect(fake.calls.at(-1)).toEqual(['setMode', 'TEST1', 'challenger', 'court-1']);
    expect(store.busy('setMode')).toBe(true);
    fake.flush();
    await tick();
    expect(store.busy('setMode')).toBe(false);
  });

  it('drops a repeat of the same action+target while one is in flight', async () => {
    const { store, fake } = makeLive(buildState(4));
    store.rest({ code: 'TEST1' });
    store.rest({ code: 'TEST1' }); // same key → ignored
    expect(fake.countOf('rest')).toBe(1);
    fake.flush();
    await tick();
    store.rest({ code: 'TEST1' }); // now settled → runs again
    expect(fake.countOf('rest')).toBe(2);
  });

  it('lets distinct targets of the same action run concurrently', () => {
    const { store, fake } = makeLive(buildState(4));
    store.activate({ code: 'TEST1' }); // self → key "activate"
    store.activate({ code: 'TEST1', id: 'p3' }); // key "activate:p3"
    expect(fake.countOf('activate')).toBe(2);
    expect(store.busy('activate')).toBe(true);
  });

  it('sets an error message and clears pending when a mutation rejects', async () => {
    const { store, fake } = makeLive(buildState(4));
    fake.rejectNext = true;
    store.addCourt({ code: 'TEST1' });
    await tick();
    expect(store.error()).toBe('Could not add a court.');
    expect(store.busy('addCourt')).toBe(false);
  });

  it('clears the prior error when a new action starts', async () => {
    const { store, fake } = makeLive(buildState(4));
    fake.rejectNext = true;
    store.addCourt({ code: 'TEST1' });
    await tick();
    expect(store.error()).not.toBeNull();
    store.endSession({ code: 'TEST1' });
    expect(store.error()).toBeNull();
  });

  it('surfaces a dismissible snackbar with the action message on failure', async () => {
    const { store, fake } = makeLive(buildState(4));
    const snack = TestBed.inject(MatSnackBar);
    const spy = vi.spyOn(snack, 'open');
    fake.rejectNext = true;
    store.addCourt({ code: 'TEST1' });
    await tick();
    expect(spy).toHaveBeenCalledWith('Could not add a court.', 'Dismiss', {
      duration: 4000,
    });
  });
});

describe('SessionStore mutation forwarding (object → positional args)', () => {
  it('join forwards the player name', () => {
    const { store, fake } = makeLive(buildState(2));
    store.join({ code: 'TEST1', name: 'Casey' });
    expect(fake.calls.at(-1)).toEqual(['join', 'TEST1', 'Casey']);
  });

  it('removePlayer forwards the player id', () => {
    const { store, fake } = makeLive(buildState(4));
    store.removePlayer({ code: 'TEST1', id: 'p2' });
    expect(fake.calls.at(-1)).toEqual(['removePlayer', 'TEST1', 'p2']);
  });

  it('removeCourt forwards the court id', () => {
    const { store, fake } = makeLive(buildState(4, 2));
    store.removeCourt({ code: 'TEST1', courtId: 'court-2' });
    expect(fake.calls.at(-1)).toEqual(['removeCourt', 'TEST1', 'court-2']);
  });

  it('reorderQueue forwards the new order array', () => {
    const { store, fake } = makeLive(buildState(6));
    store.reorderQueue({ code: 'TEST1', newQueue: ['p6', 'p5'] });
    expect(fake.calls.at(-1)).toEqual(['reorderQueue', 'TEST1', ['p6', 'p5']]);
  });

  it('finishStandardGame forwards courtId and options', () => {
    const { store, fake } = makeLive(buildState(8, 2));
    store.finishStandardGame({
      code: 'TEST1',
      courtId: 'court-1',
      opts: { winningPairIds: ['p1', 'p2'], promote: true },
    });
    expect(fake.calls.at(-1)).toEqual([
      'finishStandardGame',
      'TEST1',
      'court-1',
      { winningPairIds: ['p1', 'p2'], promote: true },
    ]);
  });

  it('finishChallengerGame forwards courtId and the winning pair', () => {
    const { store, fake } = makeLive(buildState(8, 2));
    store.finishChallengerGame({
      code: 'TEST1',
      courtId: 'court-1',
      winningPairIds: ['p1', 'p2'],
    });
    expect(fake.calls.at(-1)).toEqual([
      'finishChallengerGame',
      'TEST1',
      'court-1',
      ['p1', 'p2'],
    ]);
  });

  it('endSession forwards the code', () => {
    const { store, fake } = makeLive(buildState(2));
    store.endSession({ code: 'TEST1' });
    expect(fake.calls.at(-1)).toEqual(['endSession', 'TEST1']);
  });
});

describe('SessionStore.busy', () => {
  it('is false when no action is in flight', () => {
    const { store } = makeLive(buildState(4));
    expect(store.busy('rest')).toBe(false);
  });

  it('is true for an action whose target key is in flight', () => {
    const { store } = makeLive(buildState(4));
    store.activate({ code: 'TEST1', id: 'p3' }); // key "activate:p3"
    expect(store.busy('activate')).toBe(true);
  });

  it('does not match an unrelated action that shares a name prefix', () => {
    const { store } = makeLive(buildState(4));
    store.removeCourt({ code: 'TEST1', courtId: 'court-1' }); // key "removeCourt:court-1"
    expect(store.busy('remove')).toBe(false); // "remove" is not "removeCourt"
    expect(store.busy('removeCourt')).toBe(true);
  });
});

describe('SessionStore selectors (uncovered branches)', () => {
  it('exposes the current player name and admin ownership', () => {
    const { store } = makeLive(buildState(4), 'p1');
    expect(store.myName()).toBe('Player 1');
    expect(store.isAdmin()).toBe(false);
  });

  it('reports isAdmin true for the owning uid', () => {
    const { store } = makeLive(buildState(4), 'admin');
    expect(store.isAdmin()).toBe(true);
  });

  it('reports a null name and loading status before connecting', () => {
    const { store } = makeStore('p1');
    expect(store.myName()).toBeNull();
    expect(store.status().kind).toBe('loading');
  });
});

describe('SessionStore listener recovery', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('tears down the prior listener when switching session codes', () => {
    const { store, fake } = makeLive(buildState(2));
    expect(fake.listenCount).toBe(1);
    store.connect('test2');
    expect(fake.unsubCount).toBe(1); // old listener detached
    expect(fake.listenCount).toBe(2);
    expect(store.code()).toBe('TEST2');
    store.disconnect();
  });

  it('re-attaches after the reconnect delay when the stream errors', () => {
    const { store, fake } = makeLive(buildState(2));
    fake.emitError(new Error('permission-denied'));
    expect(store.conn()).toBe('error');
    expect(fake.listenCount).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(fake.listenCount).toBe(2);
    expect(store.conn()).toBe('live');
    store.disconnect();
  });

  it('re-attaches immediately when the tab comes back online', () => {
    const { store, fake } = makeLive(buildState(2));
    fake.emitError(new Error('offline'));
    window.dispatchEvent(new Event('online'));
    expect(fake.listenCount).toBe(2);
    expect(store.conn()).toBe('live');
    store.disconnect();
  });

  it('re-attaches when the tab becomes visible again', () => {
    const { store, fake } = makeLive(buildState(2));
    fake.emitError(new Error('offline'));
    document.dispatchEvent(new Event('visibilitychange')); // jsdom: hidden=false
    expect(fake.listenCount).toBe(2);
    expect(store.conn()).toBe('live');
    store.disconnect();
  });

  it('does not re-attach on visibilitychange while the tab is hidden', () => {
    const { store, fake } = makeLive(buildState(2));
    fake.emitError(new Error('offline'));
    const original = Object.getOwnPropertyDescriptor(
      Document.prototype,
      'hidden',
    );
    Object.defineProperty(document, 'hidden', {
      value: true,
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fake.listenCount).toBe(1); // still hidden → no reconnect
    if (original) Object.defineProperty(document, 'hidden', original);
    store.disconnect();
  });

  it('stops reacting to recovery events after disconnect', () => {
    const { store, fake } = makeLive(buildState(2));
    fake.emitError(new Error('offline'));
    store.disconnect(); // removes the recovery handlers + clears the retry timer
    const before = fake.listenCount;
    window.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(5000);
    expect(fake.listenCount).toBe(before); // no reconnection
  });
});
