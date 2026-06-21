import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    resetBrowserYieldStateForTests,
    yieldToBrowser,
} from '@app/platform/browser-api/browserYield';

class FakeMessageChannel {
    public readonly port1: { onmessage: ((event: Event) => void) | null; };

    public readonly port2: { postMessage: ReturnType<typeof vi.fn>; };

    public constructor() {
        this.port1 = { onmessage: null };
        this.port2 = { postMessage: vi.fn(() => {
            queueMicrotask(() => {
                this.port1.onmessage?.(new Event('message'));
            });
        }) };
    }
}

describe('yieldToBrowser', () => {
    beforeEach(() => {
        resetBrowserYieldStateForTests();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('waits for an animation frame when the document is visible', async () => {
        let rafCallback: FrameRequestCallback | undefined;
        let settled = false;
        const requestAnimationFrameSpy = vi.fn((callback: FrameRequestCallback) => {
            rafCallback = callback;
            return 1;
        });
        vi.stubGlobal('document', { visibilityState: 'visible' });
        vi.stubGlobal('requestAnimationFrame', requestAnimationFrameSpy);
        vi.stubGlobal('MessageChannel', FakeMessageChannel);

        const yieldPromise = yieldToBrowser().then(() => {
            settled = true;
        });
        await Promise.resolve();

        expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);

        rafCallback?.(16);
        await yieldPromise;
        expect(settled).toBe(true);
    });

    it('does not wait for an animation frame when the document is hidden', async () => {
        const requestAnimationFrameSpy = vi.fn((callback: FrameRequestCallback) => {
            callback(16);
            return 1;
        });
        const channels: FakeMessageChannel[] = [];
        vi.stubGlobal('document', { visibilityState: 'hidden' });
        vi.stubGlobal('requestAnimationFrame', requestAnimationFrameSpy);
        vi.stubGlobal('MessageChannel', class extends FakeMessageChannel {
            public constructor() {
                super();
                channels.push(this);
            }
        });

        await yieldToBrowser();

        expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
        expect(channels).toHaveLength(1);
        expect(channels[0]?.port2.postMessage).toHaveBeenCalledTimes(1);
    });

    it('falls back to timers when task channels are unavailable', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('document', { visibilityState: 'hidden' });
        vi.stubGlobal('MessageChannel', undefined);

        let settled = false;
        const yieldPromise = yieldToBrowser().then(() => {
            settled = true;
        });
        await Promise.resolve();

        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(0);
        await yieldPromise;
        expect(settled).toBe(true);
    });
});
