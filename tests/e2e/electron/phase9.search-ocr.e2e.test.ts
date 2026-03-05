import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    copyProjectFixture,
    readPdfPageSnapshots,
} from './helpers/fixtures';
import { startElectronE2ESession } from './helpers/session-harness';
import {
    acknowledgeOcrResult,
    createWorkingCopyFromPath,
    runOcrSearchablePdf,
} from './helpers/electron-api-helpers';
import {
    openPdfInApp,
    waitForPdfLoaded,
} from './helpers/viewer-helpers';

type TSearchApi = {
    warmIndex?: (
        path: string,
        options?: {
            requestId?: string;
            pageCount?: number;
        },
    ) => Promise<boolean>;
    run?: (
        path: string,
        query: string,
        options?: {
            requestId?: string;
            pageCount?: number;
        },
    ) => Promise<{
        results: unknown[];
        truncated: boolean;
    }>;
};

function pickSearchQuery(text: string) {
    const latinWord = text.match(/[A-Za-z]{4,}/)?.[0];
    if (latinWord) {
        return latinWord.toLowerCase();
    }
    const fallbackWord = text.match(/\p{L}{4,}/u)?.[0];
    if (fallbackWord) {
        return fallbackWord.toLowerCase();
    }
    return 'text';
}

describe('Electron E2E - Phase 9 (Search on OCR PDF)', () => {
    it('finds matches in sidebar search after OCR and index warmup', async () => {
        const sourcePath = copyProjectFixture('test-scanned.pdf', `phase9-scanned-${Date.now()}.pdf`);
        const session = await startElectronE2ESession(`e2e-phase9-${Date.now()}`);

        let ocrRequestId = '';
        let ocrPdfPath: string | null = null;

        try {
            await openPdfInApp(session.page, sourcePath);
            await waitForPdfLoaded(session.page);

            const workingCopyPath = await createWorkingCopyFromPath(session.page, sourcePath, sourcePath);
            expect(workingCopyPath.length).toBeGreaterThan(0);

            ocrRequestId = `ocr-search-e2e-${Date.now()}`;
            const ocrResult = await runOcrSearchablePdf(session.page, workingCopyPath, ocrRequestId);
            expect(ocrResult.started).toBe(true);
            expect(ocrResult.success).toBe(true);
            expect(ocrResult.pdfPath).toBeTruthy();

            ocrPdfPath = ocrResult.pdfPath;
            if (!ocrPdfPath) {
                throw new Error('OCR did not return a PDF path');
            }

            const snapshots = await readPdfPageSnapshots(ocrPdfPath);
            const query = pickSearchQuery(snapshots[0]?.textSnippet ?? '');

            await openPdfInApp(session.page, ocrPdfPath);
            await waitForPdfLoaded(session.page);

            const warmed = await session.page.evaluate(async ({
                pdfPath,
                requestId,
            }) => {
                const search = (window as Window & { electronAPI?: { search?: TSearchApi } }).electronAPI?.search;
                if (!search?.warmIndex) {
                    throw new Error('electronAPI.search.warmIndex is unavailable');
                }
                return search.warmIndex(pdfPath, {
                    requestId,
                    pageCount: 1,
                });
            }, {
                pdfPath: ocrPdfPath,
                requestId: `warm-${Date.now()}`,
            });
            expect(warmed).toBe(true);

            const searchResponse = await session.page.evaluate(async ({
                pdfPath,
                searchQuery,
                requestId,
            }) => {
                const search = (window as Window & { electronAPI?: { search?: TSearchApi } }).electronAPI?.search;
                if (!search?.run) {
                    throw new Error('electronAPI.search.run is unavailable');
                }
                return search.run(pdfPath, searchQuery, {
                    requestId,
                    pageCount: 1,
                });
            }, {
                pdfPath: ocrPdfPath,
                searchQuery: query,
                requestId: `search-${Date.now()}`,
            });

            expect(searchResponse.results.length).toBeGreaterThan(0);

            if (ocrResult.requiresCleanupAck) {
                const ack = await acknowledgeOcrResult(session.page, ocrRequestId, ocrPdfPath);
                expect(ack.cleaned).toBe(true);
            }
        } finally {
            if (ocrRequestId && ocrPdfPath) {
                await acknowledgeOcrResult(session.page, ocrRequestId, ocrPdfPath).catch(() => undefined);
            }
            await session.stop();
        }
    });
});
