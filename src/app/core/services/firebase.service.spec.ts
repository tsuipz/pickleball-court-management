import { vi } from 'vitest';
import { FirebaseService } from './firebase.service';

/**
 * FirebaseService is thin glue over the Firebase SDK, so this is necessarily a
 * mock-heavy test (lower fidelity than the rest of the suite). It verifies the
 * one piece of real behavior: init() wires anonymous auth into the uid signal
 * and survives a sign-in failure.
 */
const h = vi.hoisted(() => ({
  authCb: null as ((user: { uid: string } | null) => void) | null,
  signIn: () => Promise.resolve(),
}));

vi.mock('firebase/app', () => ({ initializeApp: () => ({}) }));

vi.mock('firebase/firestore', () => ({
  initializeFirestore: () => ({}),
  persistentLocalCache: () => ({}),
  persistentMultipleTabManager: () => ({}),
}));

vi.mock('firebase/auth', () => ({
  getAuth: () => ({}),
  onAuthStateChanged: (
    _auth: unknown,
    cb: (user: { uid: string } | null) => void,
  ) => {
    h.authCb = cb;
    return () => {};
  },
  signInAnonymously: () => h.signIn(),
}));

beforeEach(() => {
  h.authCb = null;
  h.signIn = () => Promise.resolve();
});

describe('FirebaseService', () => {
  it('starts with a null uid', () => {
    const svc = new FirebaseService();
    expect(svc.uid()).toBeNull();
  });

  it('publishes the uid once an anonymous user is available', () => {
    const svc = new FirebaseService();
    svc.init();
    h.authCb!({ uid: 'anon-123' });
    expect(svc.uid()).toBe('anon-123');
  });

  it('keeps the uid null while signed out', () => {
    const svc = new FirebaseService();
    svc.init();
    h.authCb!(null);
    expect(svc.uid()).toBeNull();
  });

  it('does not throw if anonymous sign-in fails', () => {
    h.signIn = () => Promise.reject(new Error('network'));
    const svc = new FirebaseService();
    expect(() => svc.init()).not.toThrow();
  });
});
