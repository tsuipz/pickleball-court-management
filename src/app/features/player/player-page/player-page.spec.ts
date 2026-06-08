import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute } from '@angular/router';
import { SessionState } from '../../../core/models/types';
import {
  addPlayer,
  createInitialSessionState,
  finishStandardGame,
  restPlayer,
  setMode,
} from '../../../core/services/rotation';
import { SessionService } from '../../../core/services/session.service';
import { SessionStore } from '../../../core/state/session-store';
import { PlayerPage } from './player-page';

/**
 * Real-signal stand-in for the SessionService data layer (no Firestore). The
 * route-scoped SessionStore is the real thing; this just feeds it a snapshot
 * via `listen` and records the mutator calls the store forwards.
 */
class FakeSessions {
  readonly uid = signal<string | null>(null);
  private snapshot: SessionState | null = null;
  calls: unknown[][] = [];

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

  private rec =
    (name: string) =>
    (...args: unknown[]) => {
      this.calls.push([name, ...args]);
      return Promise.resolve();
    };
  join = this.rec('join');
  rest = this.rec('rest');
  activate = this.rec('activate');
  removePlayer = this.rec('removePlayer');
  called(name: string) {
    return this.calls.find((c) => c[0] === name);
  }
}

function buildState(playerCount: number, courtCount = 1): SessionState {
  let s = createInitialSessionState({
    code: 'TEST1',
    name: 'Test',
    adminUid: 'admin',
    adminTokenHash: 'tok',
    courtCount,
    createdAt: 0,
  });
  for (let i = 1; i <= playerCount; i++) {
    s = addPlayer(s, `p${i}`, `Player ${i}`, i);
  }
  return s;
}

function makeWithFake(
  state: SessionState | null,
  uid: string | null,
): { page: PlayerPage; fake: FakeSessions } {
  const fake = new FakeSessions();
  fake.preset(state);
  fake.uid.set(uid);
  TestBed.configureTestingModule({
    providers: [
      SessionStore,
      { provide: SessionService, useValue: fake },
      { provide: MatSnackBar, useValue: { open: () => {} } },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: { get: () => 'TEST1' } } },
      },
    ],
  });
  return { page: TestBed.runInInjectionContext(() => new PlayerPage()), fake };
}

function makePage(state: SessionState | null, uid: string | null): PlayerPage {
  return makeWithFake(state, uid).page;
}

describe('PlayerPage.status', () => {
  it('reports loading before the session arrives', () => {
    const page = makePage(null, 'p1');
    expect(page.status().kind).toBe('loading');
  });

  it('reports the court a player is on', () => {
    const page = makePage(buildState(4), 'p1'); // p1..p4 fill court 1
    const st = page.status();
    expect(st.kind).toBe('court');
    expect(st.big).toBe('Court 1');
  });

  it('reports "up next" for the player at the front of the queue', () => {
    const page = makePage(buildState(5), 'p5'); // p5 waiting at #1
    const st = page.status();
    expect(st.kind).toBe('queue');
    expect(st.big).toBe('#1');
    expect(st.label).toContain('up next');
  });

  it('reports the queue position for a player further back', () => {
    const page = makePage(buildState(6), 'p6'); // p5,p6 waiting
    const st = page.status();
    expect(st.kind).toBe('queue');
    expect(st.big).toBe('#2');
    expect(st.detail).toBe('2 in the queue');
  });

  it('reports the challenger queue after a promotion', () => {
    let s = buildState(8, 2); // court1 p1-4, court2 p5-8
    s = setMode(s, 'challenger', 'court-1');
    s = finishStandardGame(s, 'court-2', {
      winningPairIds: ['p5', 'p6'],
      promote: true,
    });
    const page = makePage(s, 'p5');
    const st = page.status();
    expect(st.kind).toBe('challenger');
    expect(st.big).toBe('#1');
  });

  it('reports idle for a benched player', () => {
    let s = buildState(3);
    s = restPlayer(s, 'p1');
    const page = makePage(s, 'p1');
    expect(page.status().kind).toBe('idle');
  });
});

describe('PlayerPage.joined', () => {
  it('is true once the player is in the session', () => {
    const page = makePage(buildState(2), 'p1');
    expect(page.joined()).toBe(true);
  });

  it('is false for someone who has not joined', () => {
    const page = makePage(buildState(2), 'stranger');
    expect(page.joined()).toBe(false);
  });
});

describe('PlayerPage helpers', () => {
  it('isMine detects the current player on a list', () => {
    const page = makePage(buildState(4), 'p1');
    expect(page.isMine(['p1', 'p2'])).toBe(true);
    expect(page.isMine(['p3', 'p4'])).toBe(false);
  });

  it('namesOf resolves ids to a readable list', () => {
    const page = makePage(buildState(4), 'p1');
    expect(page.namesOf(['p1', 'p2'])).toBe('Player 1, Player 2');
  });

  it('namesOf returns empty string with no session', () => {
    const page = makePage(null, 'p1');
    expect(page.namesOf(['p1'])).toBe('');
  });
});

describe('PlayerPage actions', () => {
  it('join forwards the trimmed name; ignores a blank name', async () => {
    const { page, fake } = makeWithFake(buildState(2), 'p9');
    page.name.set('  Jordan  ');
    await page.join();
    expect(fake.called('join')).toEqual(['join', 'TEST1', 'Jordan']);

    fake.calls = [];
    page.name.set('   ');
    await page.join();
    expect(fake.called('join')).toBeUndefined();
  });

  it('rest and back forward to the store (and on to the service)', () => {
    const { page, fake } = makeWithFake(buildState(4), 'p1');
    page.rest();
    page.back();
    expect(fake.called('rest')).toEqual(['rest', 'TEST1', undefined]);
    expect(fake.called('activate')).toEqual(['activate', 'TEST1', undefined]);
  });

  it('leave removes the player when confirmed', () => {
    const { page, fake } = makeWithFake(buildState(4), 'p1');
    globalThis.confirm = () => true;
    page.leave();
    expect(fake.called('removePlayer')).toEqual(['removePlayer', 'TEST1', 'p1']);
  });

  it('leave does nothing when cancelled', () => {
    const { page, fake } = makeWithFake(buildState(4), 'p1');
    globalThis.confirm = () => false;
    page.leave();
    expect(fake.called('removePlayer')).toBeUndefined();
  });
});
