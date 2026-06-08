import { Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { Court, Player, PlayerId, SessionMode } from '../../../core/models/types';

/** Input data passed to the dialog when a court's game is finished. */
export interface EndGameData {
  court: Court;
  players: Record<PlayerId, Player>;
  mode: SessionMode;
  isChallengerCourt: boolean;
}

/** What the dialog returns: the chosen winning pair (if any) and whether to
 *  promote them to the challenger queue. `undefined` close = cancelled. */
export interface EndGameResult {
  winningPairIds?: PlayerId[];
  promote?: boolean;
}

/**
 * "Game finished" dialog. On the challenger court a winning pair is required
 * (they stay on); on a standard court in challenger mode a winning pair is
 * optional and can be promoted to the challenger queue; in plain standard mode
 * no winner is needed. Selection is capped at two and replaces the oldest pick.
 */
@Component({
  selector: 'app-end-game-dialog',
  imports: [MatButtonModule, MatCheckboxModule, MatDialogModule],
  templateUrl: './end-game-dialog.html',
  styleUrl: './end-game-dialog.scss',
})
export class EndGameDialog {
  readonly data = inject<EndGameData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<EndGameDialog, EndGameResult>);

  readonly selected = signal<PlayerId[]>([]);
  readonly promote = signal(false);

  readonly seats = computed(() =>
    this.data.court.playerIds.map((id) => ({
      id,
      name: this.data.players[id]?.name ?? '—',
    })),
  );

  /** The challenger court must record a winner; standard courts may skip it. */
  needsWinner = computed(() => this.data.isChallengerCourt);

  canConfirm = computed(
    () => !this.needsWinner() || this.selected().length === 2,
  );

  toggle(id: PlayerId): void {
    const cur = this.selected();
    if (cur.includes(id)) {
      this.selected.set(cur.filter((p) => p !== id));
    } else if (cur.length < 2) {
      this.selected.set([...cur, id]);
    } else {
      // Replace the oldest selection so it's easy to change your mind.
      this.selected.set([cur[1], id]);
    }
    if (this.selected().length !== 2) this.promote.set(false);
  }

  confirm(): void {
    const winningPairIds =
      this.selected().length === 2 ? this.selected() : undefined;
    this.ref.close({ winningPairIds, promote: this.promote() });
  }
}
