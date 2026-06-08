import {
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { benchedPlayers, locatePlayer } from '../../../core/services/rotation';
import { SessionService } from '../../../core/services/session.service';
import { CourtCard } from '../../admin/court-card/court-card';

type StatusKind = 'court' | 'queue' | 'challenger' | 'idle' | 'loading';

@Component({
  selector: 'app-player-page',
  imports: [FormsModule, MatFormFieldModule, MatInputModule, CourtCard],
  templateUrl: './player-page.html',
  styleUrl: './player-page.scss',
})
export class PlayerPage {
  private readonly sessions = inject(SessionService);
  private readonly route = inject(ActivatedRoute);

  readonly code = (
    this.route.snapshot.paramMap.get('code') ?? ''
  ).toUpperCase();

  readonly state = this.sessions.watch(this.code, inject(DestroyRef));
  readonly name = signal('');

  /** The current player's uid (for highlighting "you" everywhere). */
  readonly uid = this.sessions.uid;

  readonly myName = computed(() => {
    const s = this.state();
    const id = this.sessions.uid();
    return s && id ? (s.players[id]?.name ?? null) : null;
  });

  readonly queue = computed(() => {
    const s = this.state();
    const id = this.sessions.uid();
    if (!s) return [];
    return s.queue.map((pid, i) => ({
      id: pid,
      name: s.players[pid]?.name ?? '—',
      pos: i + 1,
      me: pid === id,
    }));
  });

  readonly challengerPairs = computed(() => {
    const s = this.state();
    const id = this.sessions.uid();
    if (!s) return [];
    return s.challengerQueue.map((pair) => ({
      names: pair.playerIds.map((pid) => s.players[pid]?.name ?? '—').join(' & '),
      me: !!id && pair.playerIds.includes(id),
    }));
  });

  readonly benched = computed(() => {
    const s = this.state();
    return s ? benchedPlayers(s) : [];
  });

  readonly joined = computed(() => {
    const s = this.state();
    const uid = this.sessions.uid();
    return !!s && !!uid && !!s.players[uid];
  });

  /** Big, glanceable description of where this player is right now. */
  readonly status = computed<{
    kind: StatusKind;
    label: string;
    big: string;
    detail: string;
  }>(() => {
    const s = this.state();
    const uid = this.sessions.uid();
    if (!s || !uid)
      return { kind: 'loading', label: '', big: '…', detail: '' };
    const loc = locatePlayer(s, uid);
    switch (loc.kind) {
      case 'court':
        return {
          kind: 'court',
          label: "You're on",
          big: `Court ${loc.court.number}`,
          detail: 'Game on — have fun out there!',
        };
      case 'queue':
        return {
          kind: 'queue',
          label: loc.position === 1 ? "You're up next" : "You're in line",
          big: `#${loc.position}`,
          detail:
            loc.position === 1
              ? 'Head to the next open court'
              : `${loc.total} in the queue`,
        };
      case 'challenger-queue':
        return {
          kind: 'challenger',
          label: '🏆 Challenger queue',
          big: `#${loc.position}`,
          detail: 'Win and stay on the throne',
        };
      default:
        return {
          kind: 'idle',
          label: 'Sitting out',
          big: '☕',
          detail: 'Ask the organizer to add you back in',
        };
    }
  });

  isMine(ids: string[]): boolean {
    const uid = this.sessions.uid();
    return !!uid && ids.includes(uid);
  }

  async join(): Promise<void> {
    const n = this.name().trim();
    if (!n) return;
    await this.sessions.join(this.code, n);
  }

  rest(): void {
    this.sessions.rest(this.code);
  }

  back(): void {
    this.sessions.activate(this.code);
  }

  leave(): void {
    const uid = this.sessions.uid();
    if (uid && confirm('Leave this session?')) {
      this.sessions.removePlayer(this.code, uid);
    }
  }

  namesOf(ids: string[]): string {
    const s = this.state();
    if (!s) return '';
    return ids.map((id) => s.players[id]?.name ?? '—').join(', ');
  }
}
