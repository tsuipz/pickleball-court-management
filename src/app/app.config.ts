import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { FirebaseService } from './core/services/firebase.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideAnimationsAsync(),
    // Kick off anonymous sign-in at startup (non-blocking — the app paints
    // immediately and pages show a loading state until the uid is ready).
    provideAppInitializer(() => {
      inject(FirebaseService).init();
    }),
  ],
};
