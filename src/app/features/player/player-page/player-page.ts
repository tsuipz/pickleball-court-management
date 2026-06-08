import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { SessionStore } from '../../../core/state/session-store';
import { CourtCard } from '../../admin/court-card/court-card';

/**
 * Player view (route `/session/:code`, the shareable link). Prompts for a name
 * to join, then becomes a live, glanceable dashboard: the player's own status,
 * who's on each court, and the queues — all read-only except for
 * take-a-break / I'm-back / leave. Reused by anyone who isn't the admin.
 *
 * All live state and gameplay actions come from the route-scoped
 * {@link SessionStore}; this component just connects it to the route's code and
 * binds the shared selectors to the template.
 */
@Component({
  selector: 'app-player-page',
  imports: [FormsModule, MatFormFieldModule, MatInputModule, CourtCard],
  templateUrl: './player-page.html',
  styleUrl: './player-page.scss',
})
export class PlayerPage {
  private readonly store = inject(SessionStore);
  private readonly route = inject(ActivatedRoute);

  readonly code = (
    this.route.snapshot.paramMap.get('code') ?? ''
  ).toUpperCase();

  readonly name = signal('');

  // Shared, store-owned state + selectors.
  readonly state = this.store.state;
  readonly conn = this.store.conn;
  readonly error = this.store.error;
  readonly busy = this.store.busy;
  readonly uid = this.store.uid;
  readonly myName = this.store.myName;
  readonly queue = this.store.queue;
  readonly challengerPairs = this.store.challengerPairs;
  readonly benched = this.store.benched;
  readonly joined = this.store.joined;
  readonly status = this.store.status;

  constructor() {
    this.store.connect(this.code);
  }

  isMine(ids: string[]): boolean {
    const uid = this.uid();
    return !!uid && ids.includes(uid);
  }

  async join(): Promise<void> {
    const n = this.name().trim();
    if (!n) return;
    this.store.join({ code: this.code, name: n });
  }

  rest(): void {
    this.store.rest({ code: this.code });
  }

  back(): void {
    this.store.activate({ code: this.code });
  }

  leave(): void {
    const uid = this.uid();
    if (uid && confirm('Leave this session?')) {
      this.store.removePlayer({ code: this.code, id: uid });
    }
  }

  namesOf(ids: string[]): string {
    const s = this.state();
    if (!s) return '';
    return ids.map((id) => s.players[id]?.name ?? '—').join(', ');
  }
}
