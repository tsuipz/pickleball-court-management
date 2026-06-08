import {
  CdkDragDrop,
  DragDropModule,
  moveItemInArray,
} from '@angular/cdk/drag-drop';
import { Component, effect, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Court, PlayerId } from '../../../core/models/types';
import { SessionService } from '../../../core/services/session.service';
import { SessionStore } from '../../../core/state/session-store';
import { CourtCard } from '../court-card/court-card';
import {
  EndGameData,
  EndGameDialog,
  EndGameResult,
} from '../end-game-dialog/end-game-dialog';
import { NameDialog } from '../name-dialog/name-dialog';

/**
 * Admin control surface (route `/session/:code/admin`). Shows live courts and
 * queues and drives every gameplay action through the route-scoped
 * {@link SessionStore}.
 *
 * Access control: a constructor `effect` watches the live state — if this
 * device isn't the admin it tries to reclaim the role with a token (from the
 * `?t=` transfer link or localStorage, via {@link SessionService}) and otherwise
 * redirects to the player view. The organizer can also play, bench themselves,
 * and reorder the queue.
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
  private readonly store = inject(SessionStore);
  private readonly sessions = inject(SessionService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);

  readonly code = (
    this.route.snapshot.paramMap.get('code') ?? ''
  ).toUpperCase();

  // Shared, store-owned state + selectors.
  readonly state = this.store.state;
  readonly conn = this.store.conn;
  readonly error = this.store.error;
  readonly busy = this.store.busy;
  readonly queue = this.store.queue;
  readonly challengerPairs = this.store.challengerPairs;
  readonly me = this.store.me;
  readonly myResting = this.store.myResting;
  readonly benched = this.store.benched;
  readonly canUndo = this.store.canUndo;
  readonly leaderboard = this.store.leaderboard;

  private claimTried = false;

  constructor() {
    this.store.connect(this.code);

    effect(() => {
      const s = this.state();
      const uid = this.store.uid();
      if (!s || !uid) return;
      if (s.adminUid === uid) return; // already the admin

      // A returning admin may carry a token (in the ?t= link or saved on this
      // device). Try to reclaim once; otherwise this is a player → redirect.
      const urlToken = this.route.snapshot.queryParamMap.get('t');
      const token = urlToken ?? this.sessions.storedAdminToken(this.code);
      if (token && !this.claimTried) {
        this.claimTried = true;
        this.sessions.claimAdmin(this.code, token).then((ok) => {
          if (!ok) {
            this.router.navigate(['/session', this.code]);
          } else if (urlToken) {
            // Reclaim succeeded from the link — drop the token from the URL so
            // the secret doesn't linger in history or get re-shared.
            this.router.navigate([], {
              relativeTo: this.route,
              queryParams: {},
              replaceUrl: true,
            });
          }
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
      this.store.setMode({ code: this.code, mode: 'challenger', challengerCourtId: courtId });
    } else {
      this.store.setMode({ code: this.code, mode: 'standard' });
    }
  }

  setChallengerCourt(courtId: string): void {
    this.store.setMode({ code: this.code, mode: 'challenger', challengerCourtId: courtId });
  }

  addCourt(): void {
    this.store.addCourt({ code: this.code });
  }

  removeCourt(court: Court): void {
    this.store.removeCourt({ code: this.code, courtId: court.id });
  }

  remove(id: PlayerId): void {
    this.store.removePlayer({ code: this.code, id });
  }

  selfRest(): void {
    this.store.rest({ code: this.code });
  }

  selfBack(): void {
    this.store.activate({ code: this.code });
  }

  backIn(id: PlayerId): void {
    this.store.activate({ code: this.code, id });
  }

  joinAsPlayer(): void {
    this.dialog
      .open<NameDialog, void, string>(NameDialog)
      .afterClosed()
      .subscribe((name) => {
        if (name) this.store.join({ code: this.code, name });
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
      this.store.endSession({ code: this.code });
    }
  }

  /** Revert the last action (single step). */
  undo(): void {
    this.store.undo({ code: this.code });
  }

  drop(event: CdkDragDrop<unknown>): void {
    const ids = this.queue().map((q) => q.id);
    moveItemInArray(ids, event.previousIndex, event.currentIndex);
    this.store.reorderQueue({ code: this.code, newQueue: ids });
  }

  dropChallenger(event: CdkDragDrop<unknown>): void {
    const pairs = [...(this.state()?.challengerQueue ?? [])];
    moveItemInArray(pairs, event.previousIndex, event.currentIndex);
    this.store.reorderChallengerQueue({ code: this.code, newQueue: pairs });
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
            this.store.finishChallengerGame({
              code: this.code,
              courtId: court.id,
              winningPairIds: result.winningPairIds,
            });
            this.offerUndo();
          }
        } else {
          this.store.finishStandardGame({
            code: this.code,
            courtId: court.id,
            opts: {
              winningPairIds: result.winningPairIds,
              promote: result.promote,
            },
          });
          this.offerUndo();
        }
      });
  }

  /** Show a snackbar with a quick Undo action after finishing a game. */
  private offerUndo(): void {
    this.snack
      .open('Game finished', 'Undo', { duration: 5000 })
      .onAction()
      .subscribe(() => this.undo());
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
