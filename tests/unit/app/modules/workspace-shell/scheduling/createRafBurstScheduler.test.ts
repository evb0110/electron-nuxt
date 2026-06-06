import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createRafBurstScheduler } from '@app/modules/workspace-shell/scheduling/createRafBurstScheduler';

describe('createRafBurstScheduler', () => {
    it('runs only the requested burst and then stops without rescheduling itself', () => {
        const frames: FrameRequestCallback[] = [];
        const host = {
            requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
                frames.push(callback);
                return frames.length;
            }),
            cancelAnimationFrame: vi.fn(),
        };
        const callback = vi.fn();
        const scheduler = createRafBurstScheduler(callback, host);

        scheduler.request(3);
        expect(host.requestAnimationFrame).toHaveBeenCalledTimes(1);

        frames.shift()?.(0);
        expect(callback).toHaveBeenCalledTimes(1);
        expect(host.requestAnimationFrame).toHaveBeenCalledTimes(2);

        frames.shift()?.(0);
        expect(callback).toHaveBeenCalledTimes(2);
        expect(host.requestAnimationFrame).toHaveBeenCalledTimes(3);

        frames.shift()?.(0);
        expect(callback).toHaveBeenCalledTimes(3);
        expect(host.requestAnimationFrame).toHaveBeenCalledTimes(3);
        expect(frames).toHaveLength(0);
    });
});
