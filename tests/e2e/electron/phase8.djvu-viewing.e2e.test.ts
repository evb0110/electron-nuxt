import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    findDjvuFixturePath,
    getFixtureName,
} from './helpers/fixtures';
import { startElectronE2ESession } from './helpers/session-harness';
import { openDjvuForViewing } from './helpers/electron-api-helpers';
import {
    openPdfInApp,
    waitForPdfLoaded,
} from './helpers/viewer-helpers';

const djvuFixturePath = findDjvuFixturePath();
const describeDjvu = djvuFixturePath ? describe : describe.skip;

describeDjvu('Electron E2E - Phase 8 (DjVu Viewing)', () => {
    it('opens DjVu for viewing and produces a viewable PDF', async () => {
        if (!djvuFixturePath) {
            throw new Error('DjVu fixture path not found');
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
                const host = Array.from(document.querySelectorAll('.workspace-host'))
                    .find((candidate) => {
                        const element = candidate as HTMLElement;
                        const rect = element.getBoundingClientRect();
                        const style = window.getComputedStyle(element);
                        return style.display !== 'none' && rect.width > 100 && rect.height > 100;
                    }) as HTMLElement | undefined;
                return host?.querySelectorAll('.page_container').length ?? 0;
            });
            expect(renderedPages).toBeGreaterThan(0);
            expect(getFixtureName(convertedPdfPath).endsWith('.pdf')).toBe(true);
        } finally {
            await session.stop();
        }
    });
});
