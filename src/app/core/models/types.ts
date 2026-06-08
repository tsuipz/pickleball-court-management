/** Domain model for a pickleball open-play session. */

export type PlayerId = string; // = Firebase anonymous auth uid
export type CourtId = string;

export type SessionMode = 'standard' | 'challenger';
export type SessionStatus = 'active' | 'ended';
export type CourtStatus = 'idle' | 'in-progress';
export type CourtType = 'standard' | 'challenger';

export interface Player {
  id: PlayerId;
  name: string;
  joinedAt: number;
  /** Games won (recorded when a finished game names a winning pair). */
  wins: number;
  /** Games lost. */
  losses: number;
}

export interface Court {
  id: CourtId;
  number: number;
  type: CourtType;
  status: CourtStatus;
  /** Players currently on the court (max 4). */
  playerIds: PlayerId[];
  /**
   * Challenger court only: the "staying" winning pair (length 2 when set).
   * `null` for standard courts.
   */
  incumbentPairIds: PlayerId[] | null;
  /** Epoch ms when the current in-progress game began; `null` while idle.
   *  Drives the live game timer. Stamped when a court fills, cleared when it
   *  empties; a court that stays full across an unrelated re-settle keeps its
   *  original start time. */
  startedAt: number | null;
}

/** A waiting pair in the challenger queue. (Firestore disallows nested arrays,
 *  so pairs are stored as objects rather than `PlayerId[][]`.) */
export interface ChallengerPair {
  playerIds: PlayerId[]; // length 2
}

export interface SessionState {
  code: string; // join code, also the Firestore document id
  name: string;
  adminUid: string;
  /** SHA-256 hash (hex) of the admin bearer token. The plaintext token lets
   *  another device re-claim the admin role and is distributed only via the
   *  admin transfer link (never the player link); it lives on the admin's
   *  device (localStorage) and in that link, but never in this readable doc. */
  adminTokenHash: string;
  status: SessionStatus;
  mode: SessionMode;
  challengerCourtId: CourtId | null;
  courts: Court[];
  /** All known players keyed by uid (used for name lookup everywhere). */
  players: Record<PlayerId, Player>;
  /** Ordered standard queue of waiting players (front = next up). */
  queue: PlayerId[];
  /** Ordered challenger queue of waiting pairs (front = next challenger). */
  challengerQueue: ChallengerPair[];
  createdAt: number;
  /** Snapshot of the state immediately before the last undoable write, for
   *  single-step undo. `null` when there is nothing to undo. The snapshot's own
   *  `previous` is always `null` so the chain never nests. */
  previous: SessionState | null;
}

/** Where a given player currently is — drives the player status view. */
export type PlayerLocation =
  | { kind: 'court'; court: Court }
  | { kind: 'queue'; position: number; total: number }
  | { kind: 'challenger-queue'; position: number; total: number }
  | { kind: 'idle' }
  | { kind: 'absent' };
