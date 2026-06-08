import {
  ApplicationConfig,
  inject,
  isDevMode,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideRouter } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';

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
    // PWA: register the generated service worker in production builds only.
    // Enables install-to-home-screen and makes the in-app "notify me when I'm
    // up" alerts work reliably while the app is backgrounded (see
    // NotificationService).
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
