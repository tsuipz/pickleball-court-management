import { ComponentRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Court, Player, PlayerId } from '../../../core/models/types';
import { CourtCard } from './court-card';

function court(partial: Partial<Court>): Court {
  return {
    id: 'court-1',
    number: 1,
    type: 'standard',
    status: 'in-progress',
    playerIds: [],
    incumbentPairIds: null,
    startedAt: null,
    ...partial,
  };
}

function players(...names: [PlayerId, string][]): Record<PlayerId, Player> {
  const map: Record<PlayerId, Player> = {};
  for (const [id, name] of names)
    map[id] = { id, name, joinedAt: 0, wins: 0, losses: 0 };
  return map;
}

function setup(c: Court, p: Record<PlayerId, Player>): ComponentRef<CourtCard> {
  const fixture = TestBed.createComponent(CourtCard);
  fixture.componentRef.setInput('court', c);
  fixture.componentRef.setInput('players', p);
  return fixture.componentRef;
}

describe('CourtCard.seats', () => {
  it('maps player ids to names in court order', () => {
    const ref = setup(
      court({ playerIds: ['a', 'b'] }),
      players(['a', 'Alice'], ['b', 'Bob']),
    );
    expect(ref.instance.seats()).toEqual([
      { id: 'a', name: 'Alice', incumbent: false, you: false },
      { id: 'b', name: 'Bob', incumbent: false, you: false },
    ]);
  });

  it('flags incumbents from incumbentPairIds', () => {
    const ref = setup(
      court({ playerIds: ['a', 'b', 'c', 'd'], incumbentPairIds: ['a', 'b'] }),
      players(['a', 'Alice'], ['b', 'Bob'], ['c', 'Carol'], ['d', 'Dave']),
    );
    const seats = ref.instance.seats();
    expect(seats.filter((s) => s.incumbent).map((s) => s.id)).toEqual(['a', 'b']);
    expect(seats.filter((s) => !s.incumbent).map((s) => s.id)).toEqual(['c', 'd']);
  });

  it('falls back to a dash when a name is missing', () => {
    const ref = setup(court({ playerIds: ['ghost'] }), players());
    expect(ref.instance.seats()[0].name).toBe('—');
  });

  it('returns an empty list for an empty court', () => {
    const ref = setup(court({ playerIds: [], status: 'idle' }), players());
    expect(ref.instance.seats()).toEqual([]);
  });
});

describe('CourtCard.teams', () => {
  it('splits a standard court into first-two and last-two', () => {
    const ref = setup(
      court({ playerIds: ['a', 'b', 'c', 'd'] }),
      players(['a', 'Alice'], ['b', 'Bob'], ['c', 'Carol'], ['d', 'Dave']),
    );
    const teams = ref.instance.teams();
    expect(teams[0].map((s) => s.id)).toEqual(['a', 'b']);
    expect(teams[1].map((s) => s.id)).toEqual(['c', 'd']);
  });

  it('puts the incumbent pair as Team 1 on a challenger court', () => {
    const ref = setup(
      court({
        type: 'challenger',
        playerIds: ['a', 'b', 'c', 'd'],
        incumbentPairIds: ['c', 'd'],
      }),
      players(['a', 'Alice'], ['b', 'Bob'], ['c', 'Carol'], ['d', 'Dave']),
    );
    const teams = ref.instance.teams();
    expect(teams[0].map((s) => s.id)).toEqual(['c', 'd']); // incumbents first
    expect(teams[1].map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('keeps a short-handed court in a single partial team', () => {
    const ref = setup(
      court({ playerIds: ['a', 'b', 'c'] }),
      players(['a', 'Alice'], ['b', 'Bob'], ['c', 'Carol']),
    );
    const teams = ref.instance.teams();
    expect(teams[0].map((s) => s.id)).toEqual(['a', 'b']);
    expect(teams[1].map((s) => s.id)).toEqual(['c']);
  });
});
