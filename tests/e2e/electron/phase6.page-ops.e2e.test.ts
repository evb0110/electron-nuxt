import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createMultiPageTextFixturePdf,
    readPdfPageSnapshots,
    type IPdfPageSnapshot,
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

interface IPageOpResult {
    success: boolean;
    pageCount?: number;
}

function expectDefined<T>(value: T | null | undefined, label: string): T {
    expect(value, `${label} should be defined`).toBeDefined();
    return value as T;
}

function expectString(value: unknown, label: string): string {
    expect(typeof value, `${label} should be a string`).toBe('string');
    return value as string;
}

function expectPageOpResult(value: unknown, label: string): IPageOpResult {
    expect(value, label).toEqual(expect.objectContaining({success: expect.any(Boolean)}));
    return value as IPageOpResult;
}

function expectSnapshotAt(snapshots: IPdfPageSnapshot[], index: number, label: string): IPdfPageSnapshot {
    return expectDefined(snapshots[index], label);
}

describe('Electron E2E - Phase 6 (Page Operations)', () => {
    it('rotates, reorders, and deletes pages with persisted output integrity', async () => {
        const sourcePath = await createMultiPageTextFixturePdf(`phase6-pages-${Date.now()}.pdf`, 3);
        const session = await startElectronE2ESession(`e2e-phase6-${Date.now()}`);

        try {
            const workingCopyPath = expectString(
                await createWorkingCopyFromPath(session.page, sourcePath, sourcePath),
                'workingCopyPath',
            );
            const before = await readPdfPageSnapshots(workingCopyPath);
            expect(before.length).toBe(3);
            expect(expectSnapshotAt(before, 0, 'first pre-op snapshot').textSnippet).toContain('1/3');
            expect(expectSnapshotAt(before, 2, 'third pre-op snapshot').textSnippet).toContain('3/3');

            const rotateResult = expectPageOpResult(
                await rotatePages(session.page, workingCopyPath, [1], 90),
                'rotate result',
            );
            expect(rotateResult.success).toBe(true);

            const afterRotate = await readPdfPageSnapshots(workingCopyPath);
            expect(expectSnapshotAt(afterRotate, 0, 'first rotated snapshot').rotation).toBe(90);

            const reorderResult = expectPageOpResult(
                await reorderPages(session.page, workingCopyPath, [
                    3,
                    2,
                    1,
                ]),
                'reorder result',
            );
            expect(reorderResult.success).toBe(true);
            expect(reorderResult.pageCount).toBe(3);

            const afterReorder = await readPdfPageSnapshots(workingCopyPath);
            expect(expectSnapshotAt(afterReorder, 0, 'first reordered snapshot').textSnippet).toContain('3/3');
            expect(expectSnapshotAt(afterReorder, 2, 'third reordered snapshot').textSnippet).toContain('1/3');

            const deleteResult = expectPageOpResult(
                await deletePages(session.page, workingCopyPath, [2], 3),
                'delete result',
            );
            expect(deleteResult.success).toBe(true);
            expect(deleteResult.pageCount).toBe(2);

            const afterDelete = await readPdfPageSnapshots(workingCopyPath);
            expect(afterDelete.length).toBe(2);
            expect(expectSnapshotAt(afterDelete, 0, 'first post-delete snapshot').textSnippet).toContain('3/3');
            expect(expectSnapshotAt(afterDelete, 1, 'second post-delete snapshot').textSnippet).toContain('1/3');

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
