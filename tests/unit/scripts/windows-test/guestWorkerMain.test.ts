import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    acquireGuestWorkerPipeLock,
    GuestWorkerLockBusyError,
    guestWorkerPipePath,
} from '@scripts/windows-test/guest/guestWorkerMain';

describe('guest worker single-instance pipe', () => {
    it('keys the OS-owned pipe by the canonical guest root', () => {
        expect(guestWorkerPipePath('./nested/../evb-worker-root')).toBe(guestWorkerPipePath('./evb-worker-root'));
        expect(guestWorkerPipePath('./evb-worker-root')).not.toBe(guestWorkerPipePath('./other-worker-root'));
    });

    it('refuses a second live worker for the same guest root', async () => {
        const root = `evb-worker-live-${Date.now()}-${Math.random()}`;
        const first = await acquireGuestWorkerPipeLock(root);
        try {
            await expect(acquireGuestWorkerPipeLock(root)).rejects.toBeInstanceOf(GuestWorkerLockBusyError);
        } finally {
            await first.release();
        }
    });

    it('allows a restart after the previous listener releases the OS-owned pipe', async () => {
        const root = `evb-worker-restart-${Date.now()}-${Math.random()}`;
        const first = await acquireGuestWorkerPipeLock(root);
        await first.release();

        const second = await acquireGuestWorkerPipeLock(root);
        await second.release();
    });
});
