import { TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { NameDialog } from './name-dialog';

interface Closed {
  value?: string;
  calls: number;
}

function setup(): { dialog: NameDialog; closed: Closed } {
  const closed: Closed = { calls: 0 };
  TestBed.configureTestingModule({
    providers: [
      {
        provide: MatDialogRef,
        useValue: {
          close: (v: string) => {
            closed.value = v;
            closed.calls++;
          },
        },
      },
    ],
  });
  const dialog = TestBed.runInInjectionContext(() => new NameDialog());
  return { dialog, closed };
}

describe('NameDialog.confirm', () => {
  it('closes with the trimmed name', () => {
    const { dialog, closed } = setup();
    dialog.name.set('  Sam  ');
    dialog.confirm();
    expect(closed.value).toBe('Sam');
  });

  it('does not close when the name is blank', () => {
    const { dialog, closed } = setup();
    dialog.name.set('   ');
    dialog.confirm();
    expect(closed.calls).toBe(0);
  });
});
