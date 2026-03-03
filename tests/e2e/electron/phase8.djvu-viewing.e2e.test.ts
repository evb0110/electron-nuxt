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
import { openDjvuForViewing } from './helpers/electron-api-helpers';
import {
    openPdfInApp,
    waitForPdfLoaded,
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
    it('opens DjVu for viewing and produces a viewable PDF', async () => {
        const djvuFixturePath = djvuFixture.path;
        if (!djvuFixturePath) {
            throw new Error(`DjVu fixture path not found: ${djvuFixture.reason}`);
        }

        const session = await startElectronE2ESession(`e2e-phase8-${Date.now()}`);

        try {
            const openResult = await openDjvuForViewing(session.page, djvuFixturePath);
            expect(openResult.success).toBe(true);
            expect(openResult.error).toBeUndefined();
            expect(openResult.pdfPath).toBeTruthy();
            expect((openResult.pageCount ?? 0) > 0).toBe(true);

            const convertedPdfPath = openResult.pdfPath;
            if (!convertedPdfPath) {
                throw new Error('DjVu openForViewing did not return a pdfPath');
            }

            await openPdfInApp(session.page, convertedPdfPath);
            await waitForPdfLoaded(session.page);

            const renderedPages = await session.page.evaluate(() => {
                const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
                    ?? null;
                return host?.querySelectorAll('.page_container').length ?? 0;
            });
            expect(renderedPages).toBeGreaterThan(0);
            expect(getFixtureName(convertedPdfPath).endsWith('.pdf')).toBe(true);
        } finally {
            await session.stop();
        }
    });
});
