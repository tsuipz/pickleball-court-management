import {
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Court, Player, PlayerId } from '../../../core/models/types';

interface SeatVm {
  id: PlayerId;
  name: string;
  incumbent: boolean;
  you: boolean;
}

/**
 * Presentational top-down court: renders the two doubles teams across a net,
 * marking the incumbent (staying) pair and the viewer's own tag. Shared by the
 * admin dashboard (with action buttons) and the player view (read-only). Holds
 * no state — everything comes from inputs; actions are emitted, not performed.
 */
@Component({
  selector: 'app-court-card',
  templateUrl: './court-card.html',
  styleUrl: './court-card.scss',
})
export class CourtCard {
  /** The court to render. */
  readonly court = input.required<Court>();
  /** Player directory for resolving ids to display names. */
  readonly players = input.required<Record<PlayerId, Player>>();
  /** Show the admin-only actions (Game finished / remove court). */
  readonly isAdmin = input<boolean>(false);
  /** When set, that player's tag is marked as "you". */
  readonly me = input<PlayerId | null>(null);

  /** Admin tapped "Game finished" for this court. */
  readonly finish = output<void>();
  /** Admin tapped "remove court". */
  readonly remove = output<void>();

  /** Ticks once a second to drive the live game timer. */
  private readonly now = signal(Date.now());

  constructor() {
    const id = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(id));
  }

  /** Elapsed game time as `M:SS`, or null when the court isn't mid-game. */
  readonly elapsed = computed<string | null>(() => {
    const c = this.court();
    if (c.status !== 'in-progress' || c.startedAt == null) return null;
    const secs = Math.max(0, Math.floor((this.now() - c.startedAt) / 1000));
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  });

  readonly seats = computed<SeatVm[]>(() => {
    const c = this.court();
    const players = this.players();
    const me = this.me();
    const incumbent = new Set(c.incumbentPairIds ?? []);
    return c.playerIds.map((id) => ({
      id,
      name: players[id]?.name ?? '—',
      incumbent: incumbent.has(id),
      you: id === me,
    }));
  });

  /**
   * The four players split into their two doubles teams.
   * On a challenger court the staying (incumbent) pair is Team 1; otherwise
   * the first two on the court are Team 1 and the next two are Team 2.
   */
  readonly teams = computed<SeatVm[][]>(() => {
    const c = this.court();
    const all = this.seats();
    if (c.type === 'challenger' && (c.incumbentPairIds?.length ?? 0) > 0) {
      return [
        all.filter((s) => s.incumbent),
        all.filter((s) => !s.incumbent),
      ];
    }
    return [all.slice(0, 2), all.slice(2)];
  });

  teamLabel(index: number): string {
    return index === 0 ? 'Team 1' : 'Team 2';
  }
}
