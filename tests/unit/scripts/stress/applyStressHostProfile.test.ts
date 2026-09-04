import type { Page } from 'puppeteer-core';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { applyStressHostProfile } from '@scripts/stress/applyStressHostProfile';
import { resolveStressHostProfile } from '@scripts/stress/stressHostProfiles';

function createFakePage(overrides: {
    send?: (method: string, params?: unknown) => Promise<unknown>;
    setViewport?: () => Promise<void>;
} = {}) {
    const send = vi.fn(overrides.send ?? (async () => ({})));
    const detach = vi.fn(async () => undefined);
    const setViewport = vi.fn(overrides.setViewport ?? (async () => undefined));
    const createCDPSession = vi.fn(async () => ({
        send,
        detach,
    }));
    const page = Object.assign(Object.create(null) as Page, {
        createCDPSession,
        setViewport,
    });
    return {
        page,
        send,
        detach,
        setViewport,
        createCDPSession,
    };
}

describe('applyStressHostProfile', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('sets the viewport and skips CPU throttling for an unthrottled profile', async () => {
        const fake = createFakePage();
        const profile = resolveStressHostProfile('baseline');
        expect(profile.cpuThrottlingRate).toBe(1);

        const applied = await applyStressHostProfile(fake.page, profile);

        expect(fake.setViewport).toHaveBeenCalledWith({
            width: profile.deviceMetrics.width,
            height: profile.deviceMetrics.height,
            deviceScaleFactor: profile.deviceMetrics.deviceScaleFactor,
        });
        expect(fake.send).not.toHaveBeenCalled();
        expect(applied.profile).toBe(profile);

        await applied.release();
        expect(fake.send).not.toHaveBeenCalled();
        expect(fake.detach).toHaveBeenCalledTimes(1);
    });

    it('throttles the renderer and resets to 1x exactly once on release', async () => {
        const fake = createFakePage();
        const profile = resolveStressHostProfile('slow-a');
        expect(profile.cpuThrottlingRate).toBeGreaterThan(1);

        const applied = await applyStressHostProfile(fake.page, profile);
        expect(fake.send).toHaveBeenCalledWith('Emulation.setCPUThrottlingRate', {rate: profile.cpuThrottlingRate});

        const first = applied.release();
        const second = applied.release();
        await Promise.all([
            first,
            second,
        ]);

        expect(first).toBe(second);
        expect(fake.send).toHaveBeenLastCalledWith('Emulation.setCPUThrottlingRate', {rate: 1});
        expect(fake.send).toHaveBeenCalledTimes(2);
        expect(fake.detach).toHaveBeenCalledTimes(1);
    });

    it('detaches the CDP session and rethrows when the viewport cannot be applied', async () => {
        const failure = new Error('viewport rejected');
        const fake = createFakePage({setViewport: async () => {
            throw failure;
        }});

        await expect(applyStressHostProfile(fake.page, resolveStressHostProfile('slow-a'))).rejects.toBe(failure);
        expect(fake.detach).toHaveBeenCalledTimes(1);
        expect(fake.send).not.toHaveBeenCalled();
    });

    it('gives up on a hung throttling reset after the release timeout and still detaches', async () => {
        vi.useFakeTimers();
        const fake = createFakePage({send: (_method, params) => {
            const rate = typeof params === 'object' && params !== null && 'rate' in params ? params.rate : null;
            return rate === 1 ? new Promise(() => undefined) : Promise.resolve({});
        }});
        const applied = await applyStressHostProfile(fake.page, resolveStressHostProfile('slow-a'));

        const release = applied.release();
        await vi.advanceTimersByTimeAsync(5_000);
        await release;

        expect(fake.detach).toHaveBeenCalledTimes(1);
    });
});
