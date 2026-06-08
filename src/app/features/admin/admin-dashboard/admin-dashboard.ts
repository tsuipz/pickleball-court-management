import {
  CdkDragDrop,
  DragDropModule,
  moveItemInArray,
} from '@angular/cdk/drag-drop';
import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Court, PlayerId } from '../../../core/models/types';
import { benchedPlayers, locatePlayer } from '../../../core/services/rotation';
import { SessionService } from '../../../core/services/session.service';
import { CourtCard } from '../court-card/court-card';
import {
  EndGameData,
  EndGameDialog,
  EndGameResult,
} from '../end-game-dialog/end-game-dialog';
import { NameDialog } from '../name-dialog/name-dialog';

/**
 * Admin control surface (route `/session/:code/admin`). Shows live courts and
 * queues and drives every gameplay action through {@link SessionService}.
 *
 * Access control: a constructor `effect` watches the live state — if this
 * device isn't the admin it tries to reclaim the role with a token (from the
 * `?t=` transfer link or localStorage) and otherwise redirects to the player
 * view. The organizer can also play, bench themselves, and reorder the queue.
 */
@Component({
  selector: 'app-admin-dashboard',
  imports: [
    DragDropModule,
    MatDialogModule,
    MatFormFieldModule,
    MatSelectModule,
    MatSlideToggleModule,
    CourtCard,
  ],
  templateUrl: './admin-dashboard.html',
  styleUrl: './admin-dashboard.scss',
})
export class AdminDashboard {
  private readonly sessions = inject(SessionService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);

  readonly code = (
    this.route.snapshot.paramMap.get('code') ?? ''
  ).toUpperCase();

  readonly state = this.sessions.watch(this.code, inject(DestroyRef));

  readonly queue = computed(() => {
    const s = this.state();
    if (!s) return [];
    return s.queue.map((id) => ({ id, name: s.players[id]?.name ?? '—' }));
  });

  readonly challengerPairs = computed(() => {
    const s = this.state();
    if (!s) return [];
    return s.challengerQueue.map((pair) => ({
      names: pair.playerIds
        .map((id) => s.players[id]?.name ?? '—')
        .join(' & '),
    }));
  });

  /** The admin's own player record, if they're playing. */
  readonly me = computed(() => {
    const s = this.state();
    const uid = this.sessions.uid();
    return s && uid ? (s.players[uid] ?? null) : null;
  });

  readonly myResting = computed(() => {
    const s = this.state();
    const uid = this.sessions.uid();
    return !!s && !!uid && locatePlayer(s, uid).kind === 'idle';
  });

  readonly benched = computed(() => {
    const s = this.state();
    return s ? benchedPlayers(s) : [];
  });

  private claimTried = false;

  constructor() {
    effect(() => {
      const s = this.state();
      const uid = this.sessions.uid();
      if (!s || !uid) return;
      if (s.adminUid === uid) return; // already the admin

      // A returning admin may carry a token (in the ?t= link or saved on this
      // device). Try to reclaim once; otherwise this is a player → redirect.
      const token =
        this.route.snapshot.queryParamMap.get('t') ??
        this.sessions.storedAdminToken(this.code);
      if (token && !this.claimTried) {
        this.claimTried = true;
        this.sessions.claimAdmin(this.code, token).then((ok) => {
          if (!ok) this.router.navigate(['/session', this.code]);
        });
        return;
      }
      if (!token) this.router.navigate(['/session', this.code]);
    });
  }

  toggleMode(challenger: boolean): void {
    const s = this.state();
    if (!s) return;
    if (challenger) {
      const courtId = s.challengerCourtId ?? s.courts[0]?.id;
      this.sessions.setMode(this.code, 'challenger', courtId);
    } else {
      this.sessions.setMode(this.code, 'standard');
    }
  }

  setChallengerCourt(courtId: string): void {
    this.sessions.setMode(this.code, 'challenger', courtId);
  }

  addCourt(): void {
    this.sessions.addCourt(this.code);
  }

  removeCourt(court: Court): void {
    this.sessions.removeCourt(this.code, court.id);
  }

  remove(id: PlayerId): void {
    this.sessions.removePlayer(this.code, id);
  }

  selfRest(): void {
    this.sessions.rest(this.code);
  }

  selfBack(): void {
    this.sessions.activate(this.code);
  }

  backIn(id: PlayerId): void {
    this.sessions.activate(this.code, id);
  }

  joinAsPlayer(): void {
    this.dialog
      .open<NameDialog, void, string>(NameDialog)
      .afterClosed()
      .subscribe((name) => {
        if (name) this.sessions.join(this.code, name);
      });
  }

  async copyAdminLink(): Promise<void> {
    const link = this.sessions.adminLink(this.code);
    if (!link) {
      this.snack.open(
        'Admin link is only available on the device that created the session.',
        'OK',
      );
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      this.snack.open('Admin link copied — keep it private!', undefined, {
        duration: 2500,
      });
    } catch {
      this.snack.open(link, 'OK');
    }
  }

  endSession(): void {
    if (confirm('End this session for everyone?')) {
      this.sessions.endSession(this.code);
    }
  }

  drop(event: CdkDragDrop<unknown>): void {
    const ids = this.queue().map((q) => q.id);
    moveItemInArray(ids, event.previousIndex, event.currentIndex);
    this.sessions.reorderQueue(this.code, ids);
  }

  finishGame(court: Court): void {
    const s = this.state();
    if (!s) return;
    const isChallengerCourt = court.id === s.challengerCourtId;
    const data: EndGameData = {
      court,
      players: s.players,
      mode: s.mode,
      isChallengerCourt,
    };
    this.dialog
      .open<EndGameDialog, EndGameData, EndGameResult>(EndGameDialog, { data })
      .afterClosed()
      .subscribe((result) => {
        if (!result) return;
        if (isChallengerCourt) {
          if (result.winningPairIds?.length === 2) {
            this.sessions.finishChallengerGame(
              this.code,
              court.id,
              result.winningPairIds,
            );
          }
        } else {
          this.sessions.finishStandardGame(this.code, court.id, {
            winningPairIds: result.winningPairIds,
            promote: result.promote,
          });
        }
      });
  }

  async copyLink(): Promise<void> {
    const url = `${location.origin}/session/${this.code}`;
    try {
      await navigator.clipboard.writeText(url);
      this.snack.open('Join link copied!', undefined, { duration: 2000 });
    } catch {
      this.snack.open(url, 'OK');
    }
  }
}
