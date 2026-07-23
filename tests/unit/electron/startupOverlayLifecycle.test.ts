// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { installStartupOverlayLifecycle } from '@electron/preload/installStartupOverlayLifecycle';

const OVERLAY_ID = 'evb-startup-overlay';

function dispatchClaim(pathCount: number) {
    window.dispatchEvent(new CustomEvent('evb:startup-open-claimed', {detail: {pathCount}}));
}

function dispatchAppReady() {
    window.dispatchEvent(new Event('evb:app-ready'));
}

function dispatchVisualReady() {
    window.dispatchEvent(new CustomEvent('evb:startup-open-visual-ready', {detail: {reason: 'first-page-painted'}}));
}

function install(defaultApp = false) {
    Object.defineProperty(process, 'defaultApp', {
        configurable: true,
        value: defaultApp,
    });
    const deps = {
        tracePreload: vi.fn(),
        forwardPreloadLogToMain: vi.fn(),
    };
    installStartupOverlayLifecycle(deps);
    return deps;
}

describe('installStartupOverlayLifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.head.innerHTML = '';
        document.body.innerHTML = '';
        window.sessionStorage.clear();
        delete (window as Window & {__appReady?: boolean}).__appReady;
    });

    afterEach(() => {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        Reflect.deleteProperty(process, 'defaultApp');
    });

    it('retains app-ready-only startup through the old five-second fallback', () => {
        install();
        dispatchAppReady();

        vi.advanceTimersByTime(300);
        expect(document.getElementById(OVERLAY_ID)).not.toBeNull();
        vi.advanceTimersByTime(4_700);
        expect(document.getElementById(OVERLAY_ID)).not.toBeNull();
    });

    it('removes after app-ready and an empty claim', () => {
        install();
        dispatchAppReady();
        dispatchClaim(0);

        vi.advanceTimersByTime(299);
        expect(document.getElementById(OVERLAY_ID)).not.toBeNull();
        vi.advanceTimersByTime(1);
        expect(document.getElementById(OVERLAY_ID)).toBeNull();
    });

    it('retains a positive claim through renderer-ready timing until visual-ready', () => {
        install();
        dispatchAppReady();
        dispatchClaim(1);

        vi.advanceTimersByTime(300);
        window.dispatchEvent(new Event('app:rendererReady'));
        vi.advanceTimersByTime(30_000);
        expect(document.getElementById(OVERLAY_ID)).not.toBeNull();

        dispatchVisualReady();
        expect(document.getElementById(OVERLAY_ID)).toBeNull();
    });

    it('handles an empty claim before app-ready', () => {
        install();
        dispatchClaim(0);
        vi.advanceTimersByTime(5_000);
        expect(document.getElementById(OVERLAY_ID)).not.toBeNull();

        dispatchAppReady();
        vi.advanceTimersByTime(300);
        expect(document.getElementById(OVERLAY_ID)).toBeNull();
    });

    it('removes fatal no-claim startup at the original hard deadline', () => {
        install();

        vi.advanceTimersByTime(29_999);
        expect(document.getElementById(OVERLAY_ID)).not.toBeNull();
        vi.advanceTimersByTime(1);
        expect(document.getElementById(OVERLAY_ID)).toBeNull();
    });

    it('preserves the development stabilization delay', () => {
        install(true);
        dispatchAppReady();
        dispatchClaim(0);

        vi.advanceTimersByTime(2_199);
        expect(document.getElementById(OVERLAY_ID)).not.toBeNull();
        vi.advanceTimersByTime(1);
        expect(document.getElementById(OVERLAY_ID)).toBeNull();
    });

    it('does not remount or remove twice after duplicate and late events', () => {
        const deps = install();
        dispatchAppReady();
        dispatchClaim(0);
        vi.advanceTimersByTime(300);

        dispatchAppReady();
        dispatchClaim(1);
        dispatchVisualReady();

        expect(document.getElementById(OVERLAY_ID)).toBeNull();
        expect(deps.tracePreload).toHaveBeenCalledWith(
            'startup overlay removed',
            expect.any(Object),
        );
        expect(deps.tracePreload.mock.calls.filter(([stage]) => stage === 'startup overlay removed')).toHaveLength(1);
    });
});
