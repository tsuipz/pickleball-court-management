import { DestroyRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { vi } from 'vitest';
import { SessionState } from '../models/types';
import { createInitialSessionState } from './rotation';
import { FirebaseService } from './firebase.service';
import { SessionService } from './session.service';

// In-memory Firestore stand-in (hoisted so the vi.mock factory can see it).
const h = vi.hoisted(() => ({ store: {} as Record<string, SessionState> }));

vi.mock('firebase/firestore', () => {
  const snap = (id: string) => ({
    exists: () => h.store[id] !== undefined,
    data: () => h.store[id],
  });
  return {
    doc: (_db: unknown, _col: string, id: string) => ({ id }),
    setDoc: async (ref: { id: string }, data: SessionState) => {
      h.store[ref.id] = structuredClone(data);
    },
    onSnapshot: (
      ref: { id: string },
      onNext: (s: ReturnType<typeof snap>) => void,
    ) => {
      onNext(snap(ref.id));
      return () => {};
    },
    runTransaction: async (
      _db: unknown,
      fn: (tx: {
        get: (r: { id: string }) => Promise<ReturnType<typeof snap>>;
        set: (r: { id: string }, d: SessionState) => void;
        update: (r: { id: string }, p: Partial<SessionState>) => void;
      }) => Promise<void>,
    ) =>
      fn({
        get: async (ref) => snap(ref.id),
        set: (ref, data) => {
          h.store[ref.id] = structuredClone(data);
        },
        update: (ref, patch) => {
          h.store[ref.id] = { ...h.store[ref.id], ...patch } as SessionState;
        },
      }),
  };
});

const NOOP_DESTROY = { onDestroy: () => {} } as unknown as DestroyRef;

function setup(uid: string | null = 'admin') {
  h.store = {};
  localStorage.clear();
  const fb = { db: {}, uid: signal<string | null>(uid) };
  TestBed.configureTestingModule({
    providers: [
      { provide: FirebaseService, useValue: fb },
      { provide: MatSnackBar, useValue: { open: () => {} } },
    ],
  });
  const svc = TestBed.runInInjectionContext(() => new SessionService());
  return { svc, fb };
}

function seed(code: string, partial: Partial<SessionState> = {}): SessionState {
  const base = createInitialSessionState({
    code,
    name: 'Seeded',
    adminUid: 'admin',
    adminToken: 'secret-token',
    courtCount: 2,
    createdAt: 0,
  });
  const state = { ...base, ...partial };
  h.store[code] = state;
  return state;
}

describe('SessionService.createSession', () => {
  it('writes a new session, returns a code, and stores the admin token locally', async () => {
    const { svc } = setup('admin');
    const code = await svc.createSession('Friday Night', 3, 'Pat');

    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
    const state = h.store[code];
    expect(state.courts.length).toBe(3);
    expect(state.adminUid).toBe('admin');
    expect(state.players['admin'].name).toBe('Pat'); // organizer auto-joined
    expect(state.queue).toContain('admin');
    expect(localStorage.getItem(`dink:admin:${code}`)).toBe(state.adminToken);
  });

  it('falls back to a default name and leaves the admin out when no name given', async () => {
    const { svc } = setup('admin');
    const code = await svc.createSession('', 1);
    expect(h.store[code].name).toBe('Pickleball Session');
    expect(Object.keys(h.store[code].players).length).toBe(0);
  });
});

describe('SessionService.watch', () => {
  it('emits the current session state via a signal', () => {
    const { svc } = setup('admin');
    seed('ABCDE');
    const state = svc.watch('ABCDE', NOOP_DESTROY);
    expect(state()?.code).toBe('ABCDE');
  });

  it('emits null for a missing session', () => {
    const { svc } = setup('admin');
    const state = svc.watch('NOPE1', NOOP_DESTROY);
    expect(state()).toBeNull();
  });
});

describe('SessionService gameplay mutations', () => {
  it('join adds the current player to the queue', async () => {
    const { svc, fb } = setup('admin');
    seed('ABCDE');
    fb.uid.set('p1');
    await svc.join('ABCDE', 'Bob');
    expect(h.store['ABCDE'].players['p1'].name).toBe('Bob');
    expect(h.store['ABCDE'].queue).toContain('p1');
  });

  it('addCourt and endSession persist through the transaction', async () => {
    const { svc } = setup('admin');
    seed('ABCDE');
    await svc.addCourt('ABCDE');
    expect(h.store['ABCDE'].courts.length).toBe(3);
    await svc.endSession('ABCDE');
    expect(h.store['ABCDE'].status).toBe('ended');
  });

  it('rest then activate moves a player to the bench and back', async () => {
    const { svc, fb } = setup('admin');
    seed('ABCDE');
    fb.uid.set('p1');
    await svc.join('ABCDE', 'A');
    await svc.rest('ABCDE');
    expect(h.store['ABCDE'].queue).not.toContain('p1');
    await svc.activate('ABCDE');
    expect(h.store['ABCDE'].queue).toContain('p1');
  });

  it('reports a friendly error when the session is missing', async () => {
    const { svc } = setup('admin');
    const snack = TestBed.inject(MatSnackBar);
    const spy = vi.spyOn(snack, 'open');
    await svc.addCourt('GHOST'); // no such doc → mutate throws → reported
    expect(spy).toHaveBeenCalled();
  });
});

describe('SessionService admin recovery', () => {
  it('claimAdmin succeeds with the right token and reassigns adminUid', async () => {
    const { svc, fb } = setup('newdevice');
    seed('ABCDE'); // adminToken = 'secret-token', adminUid = 'admin'
    const ok = await svc.claimAdmin('ABCDE', 'secret-token');
    expect(ok).toBe(true);
    expect(h.store['ABCDE'].adminUid).toBe('newdevice');
    expect(localStorage.getItem('dink:admin:ABCDE')).toBe('secret-token');
  });

  it('claimAdmin fails with the wrong token and leaves admin unchanged', async () => {
    const { svc } = setup('newdevice');
    seed('ABCDE');
    const ok = await svc.claimAdmin('ABCDE', 'wrong');
    expect(ok).toBe(false);
    expect(h.store['ABCDE'].adminUid).toBe('admin');
  });

  it('adminLink builds a transfer URL from the stored token, or null without one', () => {
    const { svc } = setup('admin');
    expect(svc.adminLink('ABCDE')).toBeNull();
    localStorage.setItem('dink:admin:ABCDE', 'secret-token');
    expect(svc.adminLink('ABCDE')).toContain('/session/ABCDE/admin?t=secret-token');
  });
});

describe('SessionService.isAdmin', () => {
  it('is true only when the current uid owns the session', () => {
    const { svc } = setup('admin');
    const state = seed('ABCDE');
    expect(svc.isAdmin(state)).toBe(true);
    expect(svc.isAdmin({ ...state, adminUid: 'someone-else' })).toBe(false);
    expect(svc.isAdmin(null)).toBe(false);
  });
});
