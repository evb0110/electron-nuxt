import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createSearchReadinessPoll } from '@app/modules/workspace-shell/composables/createSearchReadinessPoll';

describe('createSearchReadinessPoll', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('settles pending and future polls as false after workspace teardown', async () => {
        vi.useFakeTimers();
        const poll = createSearchReadinessPoll(50);
        const pending = poll.wait();

        poll.dispose();

        await expect(pending).resolves.toBe(false);
        await expect(poll.wait()).resolves.toBe(false);
        await vi.advanceTimersByTimeAsync(50);
    });
});
