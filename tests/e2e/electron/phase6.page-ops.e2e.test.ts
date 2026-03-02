import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createMultiPageTextFixturePdf,
    readPdfPageSnapshots,
} from './helpers/fixtures';
import { startElectronE2ESession } from './helpers/session-harness';
import {
    createWorkingCopyFromPath,
    deletePages,
    reorderPages,
    rotatePages,
} from './helpers/electron-api-helpers';
import {
    openPdfInApp,
    waitForPdfLoaded,
} from './helpers/viewer-helpers';

describe('Electron E2E - Phase 6 (Page Operations)', () => {
    it('rotates, reorders, and deletes pages with persisted output integrity', async () => {
        const sourcePath = await createMultiPageTextFixturePdf(`phase6-pages-${Date.now()}.pdf`, 3);
        const session = await startElectronE2ESession(`e2e-phase6-${Date.now()}`);

        try {
            const workingCopyPath = await createWorkingCopyFromPath(session.page, sourcePath, sourcePath);
            const before = await readPdfPageSnapshots(workingCopyPath);
            expect(before.length).toBe(3);
            expect(before[0]?.textSnippet).toContain('1/3');
            expect(before[2]?.textSnippet).toContain('3/3');

            const rotateResult = await rotatePages(session.page, workingCopyPath, [1], 90);
            expect(rotateResult.success).toBe(true);

            const afterRotate = await readPdfPageSnapshots(workingCopyPath);
            expect(afterRotate[0]?.rotation).toBe(90);

            const reorderResult = await reorderPages(session.page, workingCopyPath, [
                3,
                2,
                1,
            ]);
            expect(reorderResult.success).toBe(true);
            expect(reorderResult.pageCount).toBe(3);

            const afterReorder = await readPdfPageSnapshots(workingCopyPath);
            expect(afterReorder[0]?.textSnippet).toContain('3/3');
            expect(afterReorder[2]?.textSnippet).toContain('1/3');

            const deleteResult = await deletePages(session.page, workingCopyPath, [2], 3);
            expect(deleteResult.success).toBe(true);
            expect(deleteResult.pageCount).toBe(2);

            const afterDelete = await readPdfPageSnapshots(workingCopyPath);
            expect(afterDelete.length).toBe(2);
            expect(afterDelete[0]?.textSnippet).toContain('3/3');
            expect(afterDelete[1]?.textSnippet).toContain('1/3');

            await openPdfInApp(session.page, workingCopyPath);
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
            expect(renderedPages).toBe(2);
        } finally {
            await session.stop();
        }
    });
});
