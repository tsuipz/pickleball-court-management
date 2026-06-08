import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { SessionService } from '../../../core/services/session.service';

/**
 * Home page (route `/`). Two entry points: create a new session (optionally
 * joining it as a player by giving your name) which navigates to the admin
 * view, or jump into an existing session by code/link via {@link goJoin}.
 */
@Component({
  selector: 'app-create-session',
  imports: [FormsModule, MatFormFieldModule, MatInputModule],
  templateUrl: './create-session.html',
  styleUrl: './create-session.scss',
})
export class CreateSession {
  private readonly sessions = inject(SessionService);
  private readonly router = inject(Router);

  readonly name = signal('');
  readonly yourName = signal('');
  readonly courtCount = signal(2);
  readonly creating = signal(false);
  readonly error = signal('');
  readonly joinCode = signal('');

  bump(delta: number): void {
    this.courtCount.set(Math.max(1, Math.min(20, this.courtCount() + delta)));
  }

  async create(): Promise<void> {
    if (this.creating()) return;
    this.creating.set(true);
    this.error.set('');
    try {
      const code = await this.sessions.createSession(
        this.name(),
        this.courtCount(),
        this.yourName(),
      );
      await this.router.navigate(['/session', code, 'admin']);
    } catch (err) {
      this.error.set(
        err instanceof Error ? err.message : 'Could not create session.',
      );
      this.creating.set(false);
    }
  }

  goJoin(): void {
    const raw = this.joinCode().trim();
    if (!raw) return;
    // Accept a raw code or a pasted /session/<CODE> link.
    const match = raw.match(/session\/([A-Za-z0-9]+)/i);
    const code = (match ? match[1] : raw)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (code) this.router.navigate(['/session', code]);
  }
}
