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
  /** Bearer secret that lets another device re-claim the admin role.
   *  Distributed only via the admin transfer link (never the player link). */
  adminToken: string;
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
}

/** Where a given player currently is — drives the player status view. */
export type PlayerLocation =
  | { kind: 'court'; court: Court }
  | { kind: 'queue'; position: number; total: number }
  | { kind: 'challenger-queue'; position: number; total: number }
  | { kind: 'idle' }
  | { kind: 'absent' };
