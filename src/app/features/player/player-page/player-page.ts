import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { locatePlayer } from '../../../core/services/rotation';
import { NotificationService } from '../../../core/services/notification.service';
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
  private readonly notifications = inject(NotificationService);
  private readonly snack = inject(MatSnackBar);

  readonly code = (
    this.route.snapshot.paramMap.get('code') ?? ''
  ).toUpperCase();

  readonly name = signal('');

  /** Whether this browser can show notifications at all. */
  readonly notifySupported = this.notifications.supported;
  /** Whether "notify me when I'm up" is currently on for this session. */
  readonly notifyOn = signal(this.notifications.isEnabled(this.code));

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

  /** Last turn-state we notified on, so we fire once per transition (not on
   *  every snapshot). `undefined` until the first state primes the baseline. */
  private notifyBaseline: string | undefined = undefined;

  constructor() {
    this.store.connect(this.code);

    // Fire a notification when the player transitions onto a court or reaches
    // the front of the queue. Driven by the live listener — see
    // {@link NotificationService} for what this does and doesn't cover.
    effect(() => {
      const s = this.state();
      const uid = this.uid();
      if (!s || !uid || !s.players[uid]) return;
      const loc = locatePlayer(s, uid);
      const key =
        loc.kind === 'court'
          ? `court:${loc.court.number}`
          : loc.kind === 'queue' && loc.position === 1
            ? 'next'
            : loc.kind;

      // Prime the baseline on first sight so we don't notify for the state the
      // player was already in when they opened the page.
      if (this.notifyBaseline === undefined) {
        this.notifyBaseline = key;
        return;
      }
      if (key === this.notifyBaseline) return;
      this.notifyBaseline = key;
      if (!this.notifyOn()) return;
      if (loc.kind === 'court') {
        this.notifications.notify(
          "You're up! 🏓",
          `Head to Court ${loc.court.number}.`,
        );
      } else if (key === 'next') {
        this.notifications.notify(
          "You're next 🎾",
          "You're first in line — get ready.",
        );
      }
    });
  }

  /** Toggle "notify me when I'm up" for this session. */
  async toggleNotify(): Promise<void> {
    if (this.notifyOn()) {
      this.notifications.disable(this.code);
      this.notifyOn.set(false);
      return;
    }
    const ok = await this.notifications.enable(this.code);
    this.notifyOn.set(ok);
    if (!ok) {
      this.snack.open(
        'Notifications are blocked — enable them in your browser settings.',
        'OK',
        { duration: 5000 },
      );
    }
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
