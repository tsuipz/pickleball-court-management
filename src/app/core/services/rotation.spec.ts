import { SessionState } from '../models/types';
import {
  activatePlayer,
  addCourt,
  addPlayer,
  benchedPlayers,
  createInitialSessionState,
  endSession,
  finishChallengerGame,
  finishStandardGame,
  locatePlayer,
  removeCourt,
  removePlayer,
  reorderQueue,
  restPlayer,
  setMode,
} from './rotation';

function base(courtCount = 2): SessionState {
  return createInitialSessionState({
    code: 'TEST1',
    name: 'Test',
    adminUid: 'admin',
    adminTokenHash: 'tok',
    courtCount,
    createdAt: 0,
  });
}

/** Add N players named p1..pN, returns the resulting state. */
function withPlayers(state: SessionState, n: number): SessionState {
  let s = state;
  for (let i = 1; i <= n; i++) s = addPlayer(s, `p${i}`, `Player ${i}`, i);
  return s;
}

describe('createInitialSessionState', () => {
  it('creates the requested number of idle standard courts', () => {
    const s = base(3);
    expect(s.courts.length).toBe(3);
    expect(s.courts.every((c) => c.type === 'standard')).toBe(true);
    expect(s.courts.every((c) => c.status === 'idle')).toBe(true);
    expect(s.mode).toBe('standard');
  });
});

describe('addPlayer + auto-seating (standard mode)', () => {
  it('queues players until a court can be filled with 4', () => {
    let s = withPlayers(base(2), 3);
    expect(s.queue.length).toBe(3);
    expect(s.courts[0].status).toBe('idle');

    s = addPlayer(s, 'p4', 'Player 4', 4);
    expect(s.courts[0].status).toBe('in-progress');
    expect(s.courts[0].playerIds).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(s.queue.length).toBe(0);
  });

  it('fills a second court once 8 players are present', () => {
    const s = withPlayers(base(2), 8);
    expect(s.courts[0].playerIds.length).toBe(4);
    expect(s.courts[1].playerIds.length).toBe(4);
    expect(s.queue.length).toBe(0);
  });

  it('does not mutate the input state', () => {
    const s = base(1);
    const next = addPlayer(s, 'p1', 'P1', 1);
    expect(s.queue.length).toBe(0);
    expect(next.queue.length).toBe(1);
  });

  it('treats a re-join as a name update, not a new queue entry', () => {
    let s = withPlayers(base(1), 2);
    s = addPlayer(s, 'p1', 'Renamed', 99);
    expect(s.queue.filter((id) => id === 'p1').length).toBe(1);
    expect(s.players['p1'].name).toBe('Renamed');
  });
});

describe('finishStandardGame (standard mode)', () => {
  it('sends the four players to the back and pulls the next four', () => {
    const s = withPlayers(base(1), 8); // court has p1..p4, queue p5..p8
    const after = finishStandardGame(s, 'court-1');
    expect(after.courts[0].playerIds).toEqual(['p5', 'p6', 'p7', 'p8']);
    expect(after.queue).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('re-seats the same four when no one else is waiting', () => {
    const s = withPlayers(base(1), 4); // exactly one court-full, empty queue
    const after = finishStandardGame(s, 'court-1');
    // With no one in the queue the same four keep playing.
    expect(after.courts[0].status).toBe('in-progress');
    expect(after.courts[0].playerIds.sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(after.queue.length).toBe(0);
  });

  it('leaves the court idle when it empties and fewer than four are waiting', () => {
    // 5 players: court-1 = p1..p4, queue = p5. Remove the court's occupants so
    // the queue can never reach four.
    let s = withPlayers(base(1), 5);
    s = removePlayer(s, 'p2');
    s = removePlayer(s, 'p3');
    const after = finishStandardGame(s, 'court-1');
    expect(after.courts[0].status).toBe('idle');
    expect(after.courts[0].playerIds.length).toBe(0);
  });
});

describe('challenger mode', () => {
  it('keeps the current four as incumbent + challenger when toggled on', () => {
    const s = setMode(withPlayers(base(2), 4), 'challenger', 'court-1');
    const cc = s.courts.find((c) => c.id === 'court-1')!;
    expect(cc.type).toBe('challenger');
    expect(cc.incumbentPairIds).toEqual(['p1', 'p2']);
    expect(cc.playerIds).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(cc.status).toBe('in-progress');
  });

  it('winner stays; loser goes to back of standard queue; next pair comes on', () => {
    // 6 players: court-1 (challenger) = p1..p4, queue = p5,p6
    let s = withPlayers(base(2), 6);
    s = setMode(s, 'challenger', 'court-1');
    expect(s.courts[0].playerIds).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(s.queue).toEqual(['p5', 'p6']);

    // Incumbent pair (p1,p2) wins.
    s = finishChallengerGame(s, 'court-1', ['p1', 'p2']);
    const cc = s.courts[0];
    expect(cc.incumbentPairIds).toEqual(['p1', 'p2']); // stayed
    expect(cc.playerIds).toEqual(['p1', 'p2', 'p5', 'p6']); // new challenger pulled
    expect(s.queue).toEqual(['p3', 'p4']); // losers to back of standard queue
  });

  it('promotes the winning pair of a standard court into the challenger queue', () => {
    // court-1 = challenger (p1..p4), court-2 = standard (p5..p8)
    let s = withPlayers(base(2), 8);
    s = setMode(s, 'challenger', 'court-1');
    expect(s.courts[1].playerIds).toEqual(['p5', 'p6', 'p7', 'p8']);

    s = finishStandardGame(s, 'court-2', {
      winningPairIds: ['p5', 'p6'],
      promote: true,
    });
    expect(s.challengerQueue.length).toBe(1);
    expect(s.challengerQueue[0].playerIds).toEqual(['p5', 'p6']);
    expect(s.queue).toContain('p7');
    expect(s.queue).toContain('p8');
  });

  it('falls back to the standard queue front when the challenger queue is empty', () => {
    let s = withPlayers(base(2), 6);
    s = setMode(s, 'challenger', 'court-1');
    s = finishChallengerGame(s, 'court-1', ['p3', 'p4']); // challengers win
    const cc = s.courts[0];
    expect(cc.incumbentPairIds).toEqual(['p3', 'p4']);
    // p1,p2 lost -> back of queue (which held p5,p6); next pair p5,p6 comes on
    expect(cc.playerIds).toEqual(['p3', 'p4', 'p5', 'p6']);
    expect(s.queue).toEqual(['p1', 'p2']);
  });

  it('toggling back to standard flushes the challenger queue into the main queue', () => {
    let s = withPlayers(base(2), 8);
    s = setMode(s, 'challenger', 'court-1');
    s = finishStandardGame(s, 'court-2', {
      winningPairIds: ['p5', 'p6'],
      promote: true,
    });
    expect(s.challengerQueue.length).toBe(1);

    s = setMode(s, 'standard');
    expect(s.mode).toBe('standard');
    expect(s.challengerQueue.length).toBe(0);
    expect(s.challengerCourtId).toBeNull();
    expect(s.courts[0].type).toBe('standard');
    // The flushed pair is back in normal rotation — either re-queued or
    // auto-seated onto the now-free standard court.
    expect(locatePlayer(s, 'p5').kind).not.toBe('absent');
    expect(locatePlayer(s, 'p6').kind).not.toBe('absent');
  });
});

describe('court management', () => {
  it('addCourt seats waiting players immediately when enough are queued', () => {
    let s = withPlayers(base(1), 8); // court-1 full (p1..p4), queue p5..p8
    s = addCourt(s);
    expect(s.courts.length).toBe(2);
    expect(s.courts[1].playerIds).toEqual(['p5', 'p6', 'p7', 'p8']);
  });

  it('removeCourt returns its players to the queue', () => {
    const s = withPlayers(base(2), 8);
    const after = removeCourt(s, 'court-2');
    expect(after.courts.length).toBe(1);
    expect(after.queue).toEqual(['p5', 'p6', 'p7', 'p8']);
  });

  it('removing the challenger court reverts the session to standard mode', () => {
    let s = withPlayers(base(2), 8);
    s = setMode(s, 'challenger', 'court-1');
    s = removeCourt(s, 'court-1');
    expect(s.mode).toBe('standard');
    expect(s.challengerCourtId).toBeNull();
  });
});

describe('removePlayer', () => {
  it('removes a queued player', () => {
    const s = withPlayers(base(1), 2);
    const after = removePlayer(s, 'p1');
    expect(after.players['p1']).toBeUndefined();
    expect(after.queue).toEqual(['p2']);
  });

  it('removes a player from a court and idles it if emptied', () => {
    const s = withPlayers(base(1), 4);
    const after = removePlayer(s, 'p1');
    expect(after.courts[0].playerIds).not.toContain('p1');
    expect(after.courts[0].playerIds.length).toBe(3);
  });
});

describe('locatePlayer', () => {
  it('reports court, queue, and absent locations', () => {
    const s = withPlayers(base(1), 6); // court p1..p4, queue p5,p6
    expect(locatePlayer(s, 'p1').kind).toBe('court');

    const q = locatePlayer(s, 'p6');
    expect(q.kind).toBe('queue');
    if (q.kind === 'queue') {
      expect(q.position).toBe(2);
      expect(q.total).toBe(2);
    }

    expect(locatePlayer(s, 'ghost').kind).toBe('absent');
  });
});

describe('reorderQueue', () => {
  it('reorders without losing players', () => {
    const s = withPlayers(base(1), 3); // queue p1,p2,p3 (no court fills)
    const after = reorderQueue(s, ['p3', 'p1', 'p2']);
    expect(after.queue).toEqual(['p3', 'p1', 'p2']);
  });
});

describe('admin auto-join', () => {
  it('adds the admin to the queue when a name is given', () => {
    const s = createInitialSessionState({
      code: 'A',
      name: 'n',
      adminUid: 'admin',
      adminTokenHash: 'tok',
      courtCount: 2,
      createdAt: 0,
      adminName: 'Riley',
    });
    expect(s.players['admin']?.name).toBe('Riley');
    expect(s.queue).toEqual(['admin']);
  });

  it('leaves the admin out when no name is given', () => {
    const s = base(2);
    expect(Object.keys(s.players).length).toBe(0);
  });
});

describe('rest / activate (the bench)', () => {
  it('benches a queued player without removing them from the session', () => {
    let s = withPlayers(base(1), 3); // queue p1,p2,p3
    s = restPlayer(s, 'p2');
    expect(s.players['p2']).toBeDefined(); // still in the session
    expect(s.queue).toEqual(['p1', 'p3']);
    expect(locatePlayer(s, 'p2').kind).toBe('idle');
    expect(benchedPlayers(s).map((p) => p.id)).toEqual(['p2']);
  });

  it('benches a player from a court without yanking someone into the live game', () => {
    const s = withPlayers(base(1), 5); // court p1..p4, queue p5
    const after = restPlayer(s, 'p1');
    expect(after.courts[0].playerIds).not.toContain('p1');
    // The game in progress continues short-handed (3) — it tops back up to
    // four only when the game finishes, not mid-point.
    expect(after.courts[0].playerIds.length).toBe(3);
    expect(after.queue).toEqual(['p5']);
    expect(locatePlayer(after, 'p1').kind).toBe('idle');
  });

  it('brings a benched player back to the end of the queue', () => {
    let s = withPlayers(base(1), 3);
    s = restPlayer(s, 'p1');
    s = activatePlayer(s, 'p1');
    expect(s.queue).toEqual(['p2', 'p3', 'p1']);
    expect(benchedPlayers(s).length).toBe(0);
  });

  it('activate is a no-op for a player already in rotation', () => {
    const s = withPlayers(base(1), 2);
    const after = activatePlayer(s, 'p1');
    expect(after.queue).toEqual(['p1', 'p2']);
  });
});

describe('additional branch coverage', () => {
  it('switches the challenger court from one court to another', () => {
    let s = withPlayers(base(2), 8);
    s = setMode(s, 'challenger', 'court-1');
    expect(s.courts[0].type).toBe('challenger');

    s = setMode(s, 'challenger', 'court-2');
    expect(s.challengerCourtId).toBe('court-2');
    expect(s.courts.find((c) => c.id === 'court-2')!.type).toBe('challenger');
    expect(s.courts.find((c) => c.id === 'court-1')!.type).toBe('standard');
    expect(s.courts.find((c) => c.id === 'court-1')!.incumbentPairIds).toBeNull();
  });

  it('does not promote on a standard court when the winners are not on it', () => {
    let s = withPlayers(base(2), 8);
    s = setMode(s, 'challenger', 'court-1'); // court-2 standard with p5..p8
    const after = finishStandardGame(s, 'court-2', {
      winningPairIds: ['p1', 'p2'], // not on court-2
      promote: true,
    });
    expect(after.challengerQueue.length).toBe(0); // no promotion happened
    // p5 stays in normal rotation (not pulled into the challenger ladder).
    expect(locatePlayer(after, 'p5').kind).not.toBe('challenger-queue');
  });

  it('finishChallengerGame is a no-op when the winners are not a valid pair', () => {
    let s = withPlayers(base(2), 6);
    s = setMode(s, 'challenger', 'court-1');
    const before = s.courts[0].playerIds.join(',');
    const after = finishChallengerGame(s, 'court-1', ['p1']); // only one
    expect(after.courts[0].playerIds.join(',')).toBe(before);
  });

  it('does not re-queue a player who re-joins while already on a court', () => {
    let s = withPlayers(base(1), 4); // p1..p4 on court
    s = addPlayer(s, 'p1', 'Renamed', 99);
    expect(s.queue).toEqual([]); // not pushed to queue
    expect(s.courts[0].playerIds).toContain('p1');
    expect(s.players['p1'].name).toBe('Renamed');
  });

  it('removeCourt of the challenger court flushes its queue into the main queue', () => {
    let s = withPlayers(base(2), 8);
    s = setMode(s, 'challenger', 'court-1');
    s = finishStandardGame(s, 'court-2', {
      winningPairIds: ['p5', 'p6'],
      promote: true,
    });
    expect(s.challengerQueue.length).toBe(1);

    s = removeCourt(s, 'court-1');
    expect(s.challengerQueue.length).toBe(0);
    expect(s.queue).toContain('p5');
    expect(s.queue).toContain('p6');
  });

  it('reorderQueue ignores unknown ids and keeps dropped ids at the back', () => {
    const s = withPlayers(base(1), 3); // queue p1,p2,p3
    const after = reorderQueue(s, ['p3', 'ghost', 'p1']); // p2 omitted, ghost invalid
    expect(after.queue).toEqual(['p3', 'p1', 'p2']);
  });

  it('locatePlayer reports the challenger-queue position', () => {
    let s = withPlayers(base(2), 8);
    s = setMode(s, 'challenger', 'court-1');
    s = finishStandardGame(s, 'court-2', {
      winningPairIds: ['p5', 'p6'],
      promote: true,
    });
    const loc = locatePlayer(s, 'p5');
    expect(loc.kind).toBe('challenger-queue');
    if (loc.kind === 'challenger-queue') {
      expect(loc.position).toBe(1);
      expect(loc.total).toBe(1);
    }
  });
});

describe('endSession', () => {
  it('marks the session ended and stops re-seating', () => {
    let s = withPlayers(base(1), 3);
    s = endSession(s);
    expect(s.status).toBe('ended');
    s = addPlayer(s, 'p4', 'P4', 4);
    expect(s.courts[0].status).toBe('idle'); // no auto-seat after end
  });
});
