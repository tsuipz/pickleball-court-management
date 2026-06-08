import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Court, SessionState } from '../../../core/models/types';
import {
  addPlayer,
  createInitialSessionState,
  finishStandardGame,
  restPlayer,
  setMode,
} from '../../../core/services/rotation';
import { SessionService } from '../../../core/services/session.service';
import { SessionStore } from '../../../core/state/session-store';
import { AdminDashboard } from './admin-dashboard';

/** Flush microtasks + timers so the per-action pending guard settles. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Real-signal stand-in for the SessionService data layer (no Firebase). The
 * route-scoped SessionStore is the real thing; this feeds it a snapshot via
 * `listen` and records the mutator calls the store forwards.
 */
class FakeSessions {
  readonly uid = signal<string | null>(null);
  private snapshot: SessionState | null = null;
  calls: unknown[][] = [];
  linkValue: string | null = 'https://x/session/TEST1/admin?t=tok';

  preset(s: SessionState | null) {
    this.snapshot = s;
  }
  listen(
    _code: string,
    onState: (s: SessionState | null) => void,
    _onError: (e: unknown) => void,
  ) {
    onState(this.snapshot);
    return () => {};
  }
  isAdmin(s: SessionState | null) {
    return !!s && s.adminUid === this.uid();
  }
  storedAdminToken() {
    return 'tok';
  }
  adminLink() {
    return this.linkValue;
  }

  private rec =
    (name: string) =>
    (...args: unknown[]) => {
      this.calls.push([name, ...args]);
      return Promise.resolve();
    };

  setMode = this.rec('setMode');
  addCourt = this.rec('addCourt');
  removeCourt = this.rec('removeCourt');
  removePlayer = this.rec('removePlayer');
  rest = this.rec('rest');
  activate = this.rec('activate');
  reorderQueue = this.rec('reorderQueue');
  endSession = this.rec('endSession');
  finishStandardGame = this.rec('finishStandardGame');
  finishChallengerGame = this.rec('finishChallengerGame');
  join = this.rec('join');

  called(name: string) {
    return this.calls.find((c) => c[0] === name);
  }
}

function buildState(playerCount: number, courtCount = 2): SessionState {
  let s = createInitialSessionState({
    code: 'TEST1',
    name: 'Test',
    adminUid: 'admin',
    adminTokenHash: 'tok',
    courtCount,
    createdAt: 0,
  });
  for (let i = 1; i <= playerCount; i++) s = addPlayer(s, `p${i}`, `Player ${i}`, i);
  return s;
}

let dialogResult: unknown;

function makeAdmin(state: SessionState | null, uid = 'admin') {
  const fake = new FakeSessions();
  fake.preset(state);
  fake.uid.set(uid);
  TestBed.configureTestingModule({
    providers: [
      SessionStore,
      { provide: SessionService, useValue: fake },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: { paramMap: { get: () => 'TEST1' }, queryParamMap: { get: () => null } },
        },
      },
      { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
      {
        provide: MatDialog,
        useValue: {
          open: () => ({ afterClosed: () => ({ subscribe: (cb: (r: unknown) => void) => cb(dialogResult) }) }),
        },
      },
      { provide: MatSnackBar, useValue: { open: () => {} } },
    ],
  });
  const cmp = TestBed.runInInjectionContext(() => new AdminDashboard());
  return { cmp, fake };
}

beforeEach(() => {
  dialogResult = undefined;
  globalThis.confirm = () => true;
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: () => Promise.resolve() },
    configurable: true,
  });
});

describe('AdminDashboard computeds', () => {
  it('lists waiting players with their names', () => {
    const { cmp } = makeAdmin(buildState(6));
    expect(cmp.queue()).toEqual([
      { id: 'p5', name: 'Player 5', pos: 1, me: false },
      { id: 'p6', name: 'Player 6', pos: 2, me: false },
    ]);
  });

  it('queue is empty when no session is loaded', () => {
    const { cmp } = makeAdmin(null);
    expect(cmp.queue()).toEqual([]);
  });

  it('joins each promoted pair into a readable label', () => {
    let s = buildState(8);
    s = setMode(s, 'challenger', 'court-1');
    s = finishStandardGame(s, 'court-2', { winningPairIds: ['p5', 'p6'], promote: true });
    const { cmp } = makeAdmin(s);
    expect(cmp.challengerPairs()).toEqual([{ names: 'Player 5 & Player 6', me: false }]);
  });

  it('exposes me / myResting / benched for the organizer', () => {
    let s = buildState(2);
    s = addPlayer(s, 'admin', 'Organizer', 99);
    s = restPlayer(s, 'admin');
    const { cmp } = makeAdmin(s);
    expect(cmp.me()?.name).toBe('Organizer');
    expect(cmp.myResting()).toBe(true);
    expect(cmp.benched().map((p) => p.id)).toContain('admin');
  });

  it('me is null when the organizer is not playing', () => {
    const { cmp } = makeAdmin(buildState(2));
    expect(cmp.me()).toBeNull();
  });
});

describe('AdminDashboard actions', () => {
  it('toggleMode(true) designates a challenger court; (false) reverts', async () => {
    const { cmp, fake } = makeAdmin(buildState(4));
    cmp.toggleMode(true);
    expect(fake.called('setMode')).toEqual(['setMode', 'TEST1', 'challenger', 'court-1']);
    fake.calls = [];
    await flush(); // let the first setMode settle so the same-action guard clears
    cmp.toggleMode(false);
    expect(fake.called('setMode')).toEqual(['setMode', 'TEST1', 'standard', undefined]);
  });

  it('setChallengerCourt / addCourt / removeCourt / remove forward to the service', () => {
    const { cmp, fake } = makeAdmin(buildState(4));
    cmp.setChallengerCourt('court-2');
    cmp.addCourt();
    cmp.removeCourt({ id: 'court-2' } as Court);
    cmp.remove('p1');
    expect(fake.called('setMode')).toEqual(['setMode', 'TEST1', 'challenger', 'court-2']);
    expect(fake.called('addCourt')).toBeTruthy();
    expect(fake.called('removeCourt')).toEqual(['removeCourt', 'TEST1', 'court-2']);
    expect(fake.called('removePlayer')).toEqual(['removePlayer', 'TEST1', 'p1']);
  });

  it('self rest/back/backIn and endSession forward to the service', () => {
    const { cmp, fake } = makeAdmin(buildState(4));
    cmp.selfRest();
    cmp.selfBack();
    cmp.backIn('p3');
    cmp.endSession(); // confirm() stubbed true
    expect(fake.called('rest')).toBeTruthy();
    expect(fake.called('activate')).toEqual(['activate', 'TEST1', undefined]);
    expect(fake.calls.filter((c) => c[0] === 'activate').length).toBe(2); // selfBack + backIn
    expect(fake.called('endSession')).toBeTruthy();
  });

  it('drop reorders the queue and forwards the new order', () => {
    const { cmp, fake } = makeAdmin(buildState(6)); // queue p5,p6
    cmp.drop({ previousIndex: 0, currentIndex: 1 } as never);
    expect(fake.called('reorderQueue')).toEqual(['reorderQueue', 'TEST1', ['p6', 'p5']]);
  });

  it('finishGame on a standard court calls finishStandardGame', () => {
    dialogResult = { winningPairIds: ['p1', 'p2'], promote: true };
    const { cmp, fake } = makeAdmin(buildState(8));
    cmp.finishGame({ id: 'court-1' } as Court); // no challenger court → standard
    expect(fake.called('finishStandardGame')).toBeTruthy();
  });

  it('finishGame on the challenger court calls finishChallengerGame', () => {
    let s = buildState(8);
    s = setMode(s, 'challenger', 'court-1');
    dialogResult = { winningPairIds: ['p1', 'p2'] };
    const { cmp, fake } = makeAdmin(s);
    cmp.finishGame({ id: 'court-1' } as Court);
    expect(fake.called('finishChallengerGame')).toBeTruthy();
  });

  it('joinAsPlayer joins with the name returned by the dialog', () => {
    dialogResult = 'Casey';
    const { cmp, fake } = makeAdmin(buildState(2));
    cmp.joinAsPlayer();
    expect(fake.called('join')).toEqual(['join', 'TEST1', 'Casey']);
  });

  it('copyLink and copyAdminLink run without error (clipboard + null-link paths)', async () => {
    const { cmp, fake } = makeAdmin(buildState(2));
    await cmp.copyLink();
    await cmp.copyAdminLink(); // has link
    fake.linkValue = null;
    await cmp.copyAdminLink(); // null-link branch
    expect(true).toBe(true);
  });
});
