import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { SessionService } from '../../../core/services/session.service';
import { CreateSession } from './create-session';

class FakeRouter {
  calls: unknown[][] = [];
  navigate(commands: unknown[]) {
    this.calls.push(commands);
    return Promise.resolve(true);
  }
}

function setup(sessions: Partial<SessionService> = {}): {
  cmp: CreateSession;
  router: FakeRouter;
} {
  const router = new FakeRouter();
  TestBed.configureTestingModule({
    providers: [
      { provide: Router, useValue: router },
      { provide: SessionService, useValue: sessions },
    ],
  });
  const cmp = TestBed.runInInjectionContext(() => new CreateSession());
  return { cmp, router };
}

describe('CreateSession.goJoin', () => {
  it('navigates to the session for a raw code, upper-cased', () => {
    const { cmp, router } = setup();
    cmp.joinCode.set('rdydn');
    cmp.goJoin();
    expect(router.calls).toEqual([['/session', 'RDYDN']]);
  });

  it('extracts the code from a pasted /session/<code> link', () => {
    const { cmp, router } = setup();
    cmp.joinCode.set('http://localhost:4200/session/AB3DE');
    cmp.goJoin();
    expect(router.calls).toEqual([['/session', 'AB3DE']]);
  });

  it('strips punctuation and whitespace from a messy code', () => {
    const { cmp, router } = setup();
    cmp.joinCode.set('ab-3 de!');
    cmp.goJoin();
    expect(router.calls).toEqual([['/session', 'AB3DE']]);
  });

  it('does nothing for an empty code', () => {
    const { cmp, router } = setup();
    cmp.joinCode.set('   ');
    cmp.goJoin();
    expect(router.calls).toEqual([]);
  });
});

describe('CreateSession.bump', () => {
  it('increments and decrements the court count', () => {
    const { cmp } = setup();
    cmp.bump(1);
    expect(cmp.courtCount()).toBe(3);
    cmp.bump(-1);
    expect(cmp.courtCount()).toBe(2);
  });

  it('clamps at a minimum of one court', () => {
    const { cmp } = setup();
    cmp.bump(-5);
    expect(cmp.courtCount()).toBe(1);
  });

  it('clamps at a maximum of twenty courts', () => {
    const { cmp } = setup();
    cmp.bump(100);
    expect(cmp.courtCount()).toBe(20);
  });
});

describe('CreateSession.create', () => {
  it('creates a session and navigates to its admin view', async () => {
    const { cmp, router } = setup({
      createSession: async () => 'NEWXY',
    } as Partial<SessionService>);
    cmp.name.set('Friday');
    cmp.yourName.set('Pat');
    await cmp.create();
    expect(router.calls).toContainEqual(['/session', 'NEWXY', 'admin']);
  });

  it('surfaces an error and re-enables the button on failure', async () => {
    const { cmp, router } = setup({
      createSession: async () => {
        throw new Error('offline');
      },
    } as Partial<SessionService>);
    await cmp.create();
    expect(cmp.error()).toBe('offline');
    expect(cmp.creating()).toBe(false);
    expect(router.calls).toEqual([]);
  });
});
