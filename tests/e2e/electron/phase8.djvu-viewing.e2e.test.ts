import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    getFixtureName,
    isDjvuFixtureRequired,
    resolveDjvuFixturePath,
} from './helpers/fixtures';
import { startElectronE2ESession } from './helpers/session-harness';
import {
    openDjvuInApp,
    waitForDjvuLoaded,
} from './helpers/viewer-helpers';

const djvuFixture = resolveDjvuFixturePath();
if (!djvuFixture.path && isDjvuFixtureRequired()) {
    throw new Error(`DjVu fixture is required but unavailable: ${djvuFixture.reason}`);
}
if (!djvuFixture.path) {
    console.info(`[phase8-djvu] Skipping DjVu E2E: ${djvuFixture.reason}`);
}
const describeDjvu = djvuFixture.path ? describe : describe.skip;

describeDjvu('Electron E2E - Phase 8 (DjVu Viewing)', () => {
    it('opens DjVu for viewing in the native viewer', async () => {
        const djvuFixturePath = djvuFixture.path;
        if (!djvuFixturePath) {
            throw new Error(`DjVu fixture path not found: ${djvuFixture.reason}`);
        }

        const session = await startElectronE2ESession(`e2e-phase8-${Date.now()}`);

        try {
            await openDjvuInApp(session.page, djvuFixturePath);
            await waitForDjvuLoaded(session.page);

            const renderedState = await session.page.evaluate(() => {
                const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
                    ?? null;
                return {
                    pageShellCount: host?.querySelectorAll('.djvu-page-shell').length ?? 0,
                    imageCount: host?.querySelectorAll('.djvu-page-shell img').length ?? 0,
                    pdfPageCount: host?.querySelectorAll('.page_container').length ?? 0,
                };
            });
            expect(renderedState.pageShellCount).toBeGreaterThan(0);
            expect(renderedState.imageCount).toBeGreaterThan(0);
            expect(renderedState.pdfPageCount).toBe(0);
            expect(getFixtureName(djvuFixturePath).match(/\.djvu?$/i)).toBeTruthy();
        } finally {
            await session.stop();
        }
    });
});
