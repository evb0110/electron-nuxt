import {
    describe,
    expect,
    it,
} from 'vitest';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import { waitForFunctionInPage } from '@tests/e2e/electron/helpers/pageRuntime';

interface IVisibleWindowState {
    availHeight: number;
    availWidth: number;
    focused: boolean;
    outerHeight: number;
    outerWidth: number;
    showEventCount: number;
    visibilityState: DocumentVisibilityState;
}

interface INavigationTimelineWindow extends Window {__navigationTimeline?: Array<{ event?: string }>;}

describe('Electron E2E - Visible Window Lifecycle', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-visible-window-${Date.now()}`,
        timeoutMs: 90_000,
        windowMode: 'visible',
    });

    it('shows, maximizes, and focuses the real application window after renderer readiness', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        await waitForFunctionInPage(session.page, () => {
            const timeline = (window as INavigationTimelineWindow).__navigationTimeline ?? [];
            return document.visibilityState === 'visible'
                && document.hasFocus()
                && timeline.some(entry => entry.event === 'window-shown');
        }, { timeout: 20_000 });

        const state = await session.page.evaluate((): IVisibleWindowState => {
            const timeline = (window as INavigationTimelineWindow).__navigationTimeline ?? [];
            return {
                availHeight: window.screen.availHeight,
                availWidth: window.screen.availWidth,
                focused: document.hasFocus(),
                outerHeight: window.outerHeight,
                outerWidth: window.outerWidth,
                showEventCount: timeline.filter(entry => entry.event === 'window-shown').length,
                visibilityState: document.visibilityState,
            };
        });

        expect(state.visibilityState).toBe('visible');
        expect(state.focused).toBe(true);
        expect(state.showEventCount).toBe(1);
        expect(state.availWidth).toBeGreaterThan(0);
        expect(state.availHeight).toBeGreaterThan(0);
        expect(state.outerWidth).toBeGreaterThanOrEqual(Math.floor(state.availWidth * 0.9));
        expect(state.outerHeight).toBeGreaterThanOrEqual(Math.floor(state.availHeight * 0.85));
    });
});
