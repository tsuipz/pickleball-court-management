import { NotificationService } from './notification.service';

// jsdom does not implement the Notifications API, so `supported` is false here.
// These tests pin the safe no-op behaviour the rest of the app relies on; the
// granted/denied paths are exercised manually in a real browser (and via the
// Playwright e2e), which is the only place the Notifications API exists.
describe('NotificationService (unsupported environment)', () => {
  const svc = new NotificationService();

  it('reports the API as unsupported', () => {
    expect(svc.supported).toBe(false);
    expect(svc.permission()).toBe('unsupported');
  });

  it('is never enabled and enable() resolves false', async () => {
    expect(svc.isEnabled('ABCDE')).toBe(false);
    expect(await svc.enable('ABCDE')).toBe(false);
  });

  it('notify() and disable() are safe no-ops', async () => {
    await expect(svc.notify('hi', 'there')).resolves.toBeUndefined();
    expect(() => svc.disable('ABCDE')).not.toThrow();
  });
});
