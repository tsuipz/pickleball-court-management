import { Routes } from '@angular/router';

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
    loadComponent: () =>
      import('./features/admin/admin-dashboard/admin-dashboard').then(
        (m) => m.AdminDashboard,
      ),
  },
  {
    path: 'session/:code',
    title: 'Pickleball — Join',
    loadComponent: () =>
      import('./features/player/player-page/player-page').then(
        (m) => m.PlayerPage,
      ),
  },
  { path: '**', redirectTo: '' },
];
