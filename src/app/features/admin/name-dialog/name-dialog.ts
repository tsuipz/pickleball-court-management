import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

/** Tiny prompt for a display name. Closes with the trimmed name, or undefined. */
@Component({
  selector: 'app-name-dialog',
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  templateUrl: './name-dialog.html',
})
export class NameDialog {
  private readonly ref = inject(MatDialogRef<NameDialog, string>);
  readonly name = signal('');

  confirm(): void {
    const n = this.name().trim();
    if (n) this.ref.close(n);
  }
}
