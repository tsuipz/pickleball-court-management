import { Routes } from '@angular/router';
import { SessionStore } from './core/state/session-store';

export const routes: Routes = [
  {
    path: '',
    title: 'Pickleball — New Session',
    loadComponent: () =>
      import('./features/home/create-session/create-session').then(
        (m) => m.CreateSession,
      ),
  },
  {
    path: 'session/:code/admin',
    title: 'Pickleball — Admin',
    providers: [SessionStore],
    loadComponent: () =>
      import('./features/admin/admin-dashboard/admin-dashboard').then(
        (m) => m.AdminDashboard,
      ),
  },
  {
    path: 'session/:code',
    title: 'Pickleball — Join',
    providers: [SessionStore],
    loadComponent: () =>
      import('./features/player/player-page/player-page').then(
        (m) => m.PlayerPage,
      ),
  },
  { path: '**', redirectTo: '' },
];
