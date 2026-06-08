/**
 * Pure rotation logic for the pickleball session.
 *
 * Every exported operation takes the current `SessionState` and returns a NEW
 * state (the input is never mutated). These functions contain no Firestore or
 * Angular dependencies so they can be exhaustively unit-tested. The
 * SessionService applies them inside a Firestore transaction.
 */
import {
  ChallengerPair,
  Court,
  Player,
  PlayerId,
  PlayerLocation,
  SessionMode,
  SessionState,
} from '../models/types';

export const PLAYERS_PER_COURT = 4;
export const PAIR = 2;

function clone(s: SessionState): SessionState {
  return structuredClone(s);
}

function challengerCourt(s: SessionState): Court | undefined {
  return s.challengerCourtId
    ? s.courts.find((c) => c.id === s.challengerCourtId)
    : undefined;
}

/**
 * Take the next pair (2 players) for the challenger court: prefer the
 * challenger queue, otherwise pull the front two of the standard queue.
 * Mutates `s` in place. Returns the pair, or null if none available.
 */
function takePair(s: SessionState): PlayerId[] | null {
  if (s.challengerQueue.length > 0) {
    return s.challengerQueue.shift()!.playerIds;
  }
  if (s.queue.length >= PAIR) {
    return s.queue.splice(0, PAIR);
  }
  return null;
}

/** Seat waiting players onto any empty standard court (groups of 4). A court
 *  that gets seated starts a new game, so its timer is stamped with `now`. */
function fillStandardCourts(s: SessionState, now: number): void {
  for (const court of s.courts) {
    if (court.id === s.challengerCourtId) continue;
    if (
      court.status === 'idle' &&
      court.playerIds.length === 0 &&
      s.queue.length >= PLAYERS_PER_COURT
    ) {
      court.playerIds = s.queue.splice(0, PLAYERS_PER_COURT);
      court.status = 'in-progress';
      court.startedAt = now;
    }
  }
}

/** Ensure the challenger court has an incumbent pair + a challenger pair. The
 *  game timer is (re)stamped only on the transition into a full court, so a
 *  game already underway keeps its original start time across re-settles. */
function fillChallengerCourt(s: SessionState, now: number): void {
  const court = challengerCourt(s);
  if (!court) return;

  const wasInProgress = court.status === 'in-progress';

  let incumbent = court.incumbentPairIds ?? [];
  if (incumbent.length < PAIR) {
    const pair = takePair(s);
    if (pair) incumbent = pair;
  }

  let challenger = court.playerIds.filter((id) => !incumbent.includes(id));
  if (challenger.length < PAIR) {
    const pair = takePair(s);
    challenger = pair ?? [];
  } else {
    challenger = challenger.slice(0, PAIR);
  }

  court.incumbentPairIds = incumbent.length === PAIR ? incumbent : null;
  court.playerIds = [...incumbent, ...challenger];
  const full = court.playerIds.length === PLAYERS_PER_COURT;
  court.status = full ? 'in-progress' : 'idle';
  if (full && !wasInProgress) court.startedAt = now;
  if (!full) court.startedAt = null;
}

/** Re-seat courts after any change. No-op once the session has ended.
 *  The challenger court is filled FIRST so it gets priority on the next pair
 *  before standard courts consume the queue. `now` stamps the timer on any
 *  court that starts a fresh game. */
function settle(s: SessionState, now: number): void {
  if (s.status === 'ended') return;
  if (s.challengerCourtId) fillChallengerCourt(s, now);
  fillStandardCourts(s, now);
}

/** Record a finished game's result onto the players' win/loss tallies. */
function recordResult(
  s: SessionState,
  winnerIds: PlayerId[],
  loserIds: PlayerId[],
): void {
  for (const id of winnerIds) {
    const p = s.players[id];
    if (p) p.wins = (p.wins ?? 0) + 1;
  }
  for (const id of loserIds) {
    const p = s.players[id];
    if (p) p.losses = (p.losses ?? 0) + 1;
  }
}

// --- Construction ---------------------------------------------------------

/**
 * Build a fresh session: N idle standard courts, empty queues, standard mode.
 * If `adminName` is given, the admin is also seated into the queue as a player
 * (and courts are settled), so an organizer who wants to play gets a spot.
 */
export function createInitialSessionState(args: {
  code: string;
  name: string;
  adminUid: string;
  adminTokenHash: string;
  courtCount: number;
  createdAt: number;
  /** When set, the admin is added as a player (in the queue) right away. */
  adminName?: string;
}): SessionState {
  const courts: Court[] = [];
  for (let i = 0; i < args.courtCount; i++) {
    courts.push({
      id: `court-${i + 1}`,
      number: i + 1,
      type: 'standard',
      status: 'idle',
      playerIds: [],
      incumbentPairIds: null,
      startedAt: null,
    });
  }
  const s: SessionState = {
    code: args.code,
    name: args.name,
    adminUid: args.adminUid,
    adminTokenHash: args.adminTokenHash,
    status: 'active',
    mode: 'standard',
    challengerCourtId: null,
    courts,
    players: {},
    queue: [],
    challengerQueue: [],
    createdAt: args.createdAt,
    previous: null,
  };
  const adminName = args.adminName?.trim();
  if (adminName) {
    s.players[args.adminUid] = {
      id: args.adminUid,
      name: adminName,
      joinedAt: args.createdAt,
      wins: 0,
      losses: 0,
    };
    s.queue.push(args.adminUid);
    settle(s, args.createdAt);
  }
  return s;
}

// --- Players --------------------------------------------------------------

/**
 * Add a player to the session by uid. New players go to the back of the queue
 * (and courts re-settle); a returning uid just has its display name refreshed,
 * keeping its current spot.
 */
export function addPlayer(
  state: SessionState,
  id: PlayerId,
  name: string,
  now: number,
): SessionState {
  const s = clone(state);
  if (s.players[id]) {
    // Returning player: just refresh the display name, keep their spot (and
    // their win/loss tally).
    s.players[id].name = name;
  } else {
    s.players[id] = { id, name, joinedAt: now, wins: 0, losses: 0 };
    s.queue.push(id);
  }
  settle(s, now);
  return s;
}

/** Pull a player out of all active rotation (queue, courts, challenger queue).
 *  Mutates `s` in place; does NOT touch the players map. */
function pullFromRotation(s: SessionState, id: PlayerId): void {
  s.queue = s.queue.filter((p) => p !== id);

  // If they were waiting in a challenger pair, dissolve it and send the
  // partner back to the standard queue.
  const keptPairs: ChallengerPair[] = [];
  for (const pair of s.challengerQueue) {
    if (pair.playerIds.includes(id)) {
      const partner = pair.playerIds.find((p) => p !== id);
      if (partner) s.queue.push(partner);
    } else {
      keptPairs.push(pair);
    }
  }
  s.challengerQueue = keptPairs;

  for (const court of s.courts) {
    if (court.playerIds.includes(id)) {
      court.playerIds = court.playerIds.filter((p) => p !== id);
      if (court.incumbentPairIds) {
        court.incumbentPairIds = court.incumbentPairIds.filter((p) => p !== id);
        if (court.incumbentPairIds.length === 0) court.incumbentPairIds = null;
      }
      if (court.playerIds.length === 0) {
        court.status = 'idle';
        court.startedAt = null;
      }
    }
  }
}

/** Remove a player from the session entirely. */
export function removePlayer(
  state: SessionState,
  id: PlayerId,
  now: number = Date.now(),
): SessionState {
  const s = clone(state);
  pullFromRotation(s, id);
  delete s.players[id];
  settle(s, now);
  return s;
}

/** Sit a player out — they stay in the session (on the bench) but leave
 *  rotation until they come back. */
export function restPlayer(
  state: SessionState,
  id: PlayerId,
  now: number = Date.now(),
): SessionState {
  const s = clone(state);
  if (!s.players[id]) return s;
  pullFromRotation(s, id);
  settle(s, now);
  return s;
}

/** Bring a benched player back into rotation (to the back of the queue). */
export function activatePlayer(
  state: SessionState,
  id: PlayerId,
  now: number = Date.now(),
): SessionState {
  const s = clone(state);
  if (!s.players[id]) return s;
  if (locatePlayer(s, id).kind === 'idle') {
    s.queue.push(id);
    settle(s, now);
  }
  return s;
}

/** Players who are in the session but currently sitting out. */
export function benchedPlayers(s: SessionState): Player[] {
  return Object.values(s.players).filter(
    (p) => locatePlayer(s, p.id).kind === 'idle',
  );
}

// --- Courts ---------------------------------------------------------------

/** Add a new idle standard court (numbered after the highest existing one),
 *  then seat waiting players if enough are queued. */
export function addCourt(
  state: SessionState,
  now: number = Date.now(),
): SessionState {
  const s = clone(state);
  const maxNumber = s.courts.reduce((m, c) => Math.max(m, c.number), 0);
  const number = maxNumber + 1;
  s.courts.push({
    id: `court-${number}`,
    number,
    type: 'standard',
    status: 'idle',
    playerIds: [],
    incumbentPairIds: null,
    startedAt: null,
  });
  settle(s, now);
  return s;
}

/** Remove a court, returning its players to the queue. Removing the challenger
 *  court also reverts the session to standard mode and flushes the challenger
 *  queue back into the standard queue. */
export function removeCourt(
  state: SessionState,
  courtId: string,
  now: number = Date.now(),
): SessionState {
  const s = clone(state);
  const court = s.courts.find((c) => c.id === courtId);
  if (!court) return s;

  s.queue.push(...court.playerIds);

  if (s.challengerCourtId === courtId) {
    for (const pair of s.challengerQueue) s.queue.push(...pair.playerIds);
    s.challengerQueue = [];
    s.challengerCourtId = null;
    s.mode = 'standard';
  }

  s.courts = s.courts.filter((c) => c.id !== courtId);
  settle(s, now);
  return s;
}

// --- Mode -----------------------------------------------------------------

/**
 * Switch between standard and challenger mode.
 * - To challenger: designate `challengerCourtId` (defaults to the current one
 *   or the first court). A court already holding four keeps playing with its
 *   first two as the incumbent pair; a partially-filled court is reseeded.
 * - To standard: revert the challenger court and flush the challenger queue
 *   back into the standard queue.
 */
export function setMode(
  state: SessionState,
  mode: SessionMode,
  challengerCourtId?: string,
  now: number = Date.now(),
): SessionState {
  const s = clone(state);

  if (mode === 'standard') {
    const prev = challengerCourt(s);
    if (prev) {
      prev.type = 'standard';
      prev.incumbentPairIds = null;
    }
    for (const pair of s.challengerQueue) s.queue.push(...pair.playerIds);
    s.challengerQueue = [];
    s.challengerCourtId = null;
    s.mode = 'standard';
    settle(s, now);
    return s;
  }

  // mode === 'challenger'
  const targetId = challengerCourtId ?? s.challengerCourtId ?? s.courts[0]?.id;
  const target = s.courts.find((c) => c.id === targetId);
  if (!target) return s;

  // Revert any previously designated challenger court.
  for (const c of s.courts) {
    if (c.id !== target.id && c.type === 'challenger') {
      c.type = 'standard';
      c.incumbentPairIds = null;
    }
  }

  s.mode = 'challenger';
  s.challengerCourtId = target.id;
  target.type = 'challenger';

  if (!target.incumbentPairIds || target.incumbentPairIds.length < PAIR) {
    if (target.playerIds.length === PLAYERS_PER_COURT) {
      // Keep the current four playing — split into incumbent + challenger.
      target.incumbentPairIds = target.playerIds.slice(0, PAIR);
    } else if (target.playerIds.length > 0) {
      // Partially filled: reseed cleanly from the queues.
      s.queue.push(...target.playerIds);
      target.playerIds = [];
      target.incumbentPairIds = null;
    }
  }
  settle(s, now);
  return s;
}

// --- Finishing games ------------------------------------------------------

export interface StandardFinishOptions {
  /** The winning pair (challenger mode only, needed to offer promotion). */
  winningPairIds?: PlayerId[];
  /** When true, promote the winners into the challenger queue. */
  promote?: boolean;
}

/** "Game finished" on a standard court. */
export function finishStandardGame(
  state: SessionState,
  courtId: string,
  opts: StandardFinishOptions = {},
  now: number = Date.now(),
): SessionState {
  const s = clone(state);
  const court = s.courts.find((c) => c.id === courtId);
  if (!court || court.id === s.challengerCourtId) return s;

  const onCourt = [...court.playerIds];
  court.playerIds = [];
  court.status = 'idle';
  court.startedAt = null;

  const winners = opts.winningPairIds ?? [];
  const hasWinner =
    winners.length === PAIR && winners.every((id) => onCourt.includes(id));

  // Record the win/loss tally whenever a valid winning pair was named —
  // independent of promotion, so plain standard games also count.
  if (hasWinner) {
    const losers = onCourt.filter((id) => !winners.includes(id));
    recordResult(s, winners, losers);
  }

  if (s.mode === 'challenger' && opts.promote && hasWinner) {
    const losers = onCourt.filter((id) => !winners.includes(id));
    s.challengerQueue.push({ playerIds: winners });
    s.queue.push(...losers);
  } else {
    s.queue.push(...onCourt);
  }
  settle(s, now);
  return s;
}

/** "Game finished" on the challenger court (2-on / 2-off, winner stays). */
export function finishChallengerGame(
  state: SessionState,
  courtId: string,
  winningPairIds: PlayerId[],
  now: number = Date.now(),
): SessionState {
  const s = clone(state);
  const court = s.courts.find((c) => c.id === courtId);
  if (!court || court.id !== s.challengerCourtId) return s;

  const onCourt = [...court.playerIds];
  const winners = winningPairIds.filter((id) => onCourt.includes(id));
  if (winners.length !== PAIR) return s; // invalid selection — no-op

  const losers = onCourt.filter((id) => !winners.includes(id));
  recordResult(s, winners, losers);
  s.queue.push(...losers); // losers go to the BACK of the standard queue

  court.incumbentPairIds = winners; // winners stay
  court.playerIds = [...winners];
  court.status = 'idle';
  court.startedAt = null;
  settle(s, now); // pulls the next challenger pair onto the court
  return s;
}

/** Mark the session ended. After this, `settle()` stops re-seating courts. */
export function endSession(state: SessionState): SessionState {
  const s = clone(state);
  s.status = 'ended';
  return s;
}

/** Admin-driven manual reorder of the standard queue. */
export function reorderQueue(
  state: SessionState,
  newQueue: PlayerId[],
): SessionState {
  const s = clone(state);
  const valid = newQueue.filter((id) => s.queue.includes(id));
  // Preserve any ids the caller dropped, appended at the back.
  const missing = s.queue.filter((id) => !valid.includes(id));
  s.queue = [...valid, ...missing];
  return s;
}

/** Stable identity for a challenger pair, order-independent. */
function pairKey(p: ChallengerPair): string {
  return [...p.playerIds].sort().join('|');
}

/** Admin-driven manual reorder of the challenger queue. Pairs are matched to
 *  the existing queue by their (order-independent) membership; any pair the
 *  caller dropped is preserved at the back. */
export function reorderChallengerQueue(
  state: SessionState,
  newQueue: ChallengerPair[],
): SessionState {
  const s = clone(state);
  const existing = new Map(s.challengerQueue.map((p) => [pairKey(p), p]));
  const used = new Set<string>();
  const result: ChallengerPair[] = [];
  for (const p of newQueue) {
    const k = pairKey(p);
    const found = existing.get(k);
    if (found && !used.has(k)) {
      result.push(found);
      used.add(k);
    }
  }
  for (const p of s.challengerQueue) {
    if (!used.has(pairKey(p))) result.push(p);
  }
  s.challengerQueue = result;
  return s;
}

/** Revert to the snapshot taken before the last undoable write (single step).
 *  The restored state's own `previous` is cleared, so there is nothing further
 *  to undo. A no-op (returns a clone) when there is no snapshot. */
export function undo(state: SessionState): SessionState {
  if (!state.previous) return clone(state);
  const restored = clone(state.previous);
  restored.previous = null;
  return restored;
}

// --- Queries --------------------------------------------------------------

/** Find where a player currently is (on a court, in a queue, benched, or not
 *  in the session) — drives the player status view and the bench list. */
export function locatePlayer(s: SessionState, id: PlayerId): PlayerLocation {
  if (!s.players[id]) return { kind: 'absent' };

  for (const court of s.courts) {
    if (court.playerIds.includes(id)) return { kind: 'court', court };
  }
  const qi = s.queue.indexOf(id);
  if (qi >= 0) {
    return { kind: 'queue', position: qi + 1, total: s.queue.length };
  }
  for (let i = 0; i < s.challengerQueue.length; i++) {
    if (s.challengerQueue[i].playerIds.includes(id)) {
      return {
        kind: 'challenger-queue',
        position: i + 1,
        total: s.challengerQueue.length,
      };
    }
  }
  return { kind: 'idle' };
}
