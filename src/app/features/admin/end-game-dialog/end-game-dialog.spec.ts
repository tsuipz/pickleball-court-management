import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { Court, Player, PlayerId } from '../../../core/models/types';
import {
  EndGameData,
  EndGameDialog,
  EndGameResult,
} from './end-game-dialog';

const COURT: Court = {
  id: 'court-1',
  number: 1,
  type: 'challenger',
  status: 'in-progress',
  playerIds: ['a', 'b', 'c', 'd'],
  incumbentPairIds: ['a', 'b'],
};

function players(): Record<PlayerId, Player> {
  return {
    a: { id: 'a', name: 'Alice', joinedAt: 0 },
    b: { id: 'b', name: 'Bob', joinedAt: 0 },
    c: { id: 'c', name: 'Carol', joinedAt: 0 },
    d: { id: 'd', name: 'Dave', joinedAt: 0 },
  };
}

interface Closed {
  value?: EndGameResult;
}

function setup(data: EndGameData): { dialog: EndGameDialog; closed: Closed } {
  const closed: Closed = {};
  TestBed.configureTestingModule({
    providers: [
      { provide: MAT_DIALOG_DATA, useValue: data },
      {
        provide: MatDialogRef,
        useValue: { close: (v: EndGameResult) => (closed.value = v) },
      },
    ],
  });
  const dialog = TestBed.runInInjectionContext(() => new EndGameDialog());
  return { dialog, closed };
}

function challengerData(): EndGameData {
  return {
    court: COURT,
    players: players(),
    mode: 'challenger',
    isChallengerCourt: true,
  };
}

function standardData(): EndGameData {
  return {
    court: { ...COURT, type: 'standard', incumbentPairIds: null },
    players: players(),
    mode: 'standard',
    isChallengerCourt: false,
  };
}

describe('EndGameDialog.toggle', () => {
  it('selects up to two players', () => {
    const { dialog } = setup(challengerData());
    dialog.toggle('a');
    dialog.toggle('b');
    expect(dialog.selected()).toEqual(['a', 'b']);
  });

  it('deselects a player that was already selected', () => {
    const { dialog } = setup(challengerData());
    dialog.toggle('a');
    dialog.toggle('a');
    expect(dialog.selected()).toEqual([]);
  });

  it('replaces the oldest selection when a third is picked', () => {
    const { dialog } = setup(challengerData());
    dialog.toggle('a');
    dialog.toggle('b');
    dialog.toggle('c'); // drops 'a'
    expect(dialog.selected()).toEqual(['b', 'c']);
  });
});

describe('EndGameDialog.canConfirm', () => {
  it('requires exactly two winners on the challenger court', () => {
    const { dialog } = setup(challengerData());
    expect(dialog.canConfirm()).toBe(false);
    dialog.toggle('a');
    expect(dialog.canConfirm()).toBe(false);
    dialog.toggle('b');
    expect(dialog.canConfirm()).toBe(true);
  });

  it('allows confirming a standard court with no winner selected', () => {
    const { dialog } = setup(standardData());
    expect(dialog.canConfirm()).toBe(true);
  });
});

describe('EndGameDialog.confirm', () => {
  it('closes with the winning pair on the challenger court', () => {
    const { dialog, closed } = setup(challengerData());
    dialog.toggle('a');
    dialog.toggle('b');
    dialog.confirm();
    expect(closed.value).toEqual({ winningPairIds: ['a', 'b'], promote: false });
  });

  it('closes with no winning pair when fewer than two are selected', () => {
    const { dialog, closed } = setup(standardData());
    dialog.confirm();
    expect(closed.value).toEqual({ winningPairIds: undefined, promote: false });
  });

  it('clears the promote flag when the selection drops below two', () => {
    const { dialog } = setup(standardData());
    dialog.toggle('a');
    dialog.toggle('b');
    dialog.promote.set(true);
    dialog.toggle('c'); // still two (b,c) — promote stays
    expect(dialog.promote()).toBe(true);
    dialog.toggle('c'); // now one — promote resets
    expect(dialog.promote()).toBe(false);
  });
});
