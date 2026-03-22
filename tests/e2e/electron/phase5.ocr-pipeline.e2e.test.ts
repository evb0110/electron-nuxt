import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    copyProjectFixture,
    readPdfPageSnapshots,
    type IPdfPageSnapshot,
} from './helpers/fixtures';
import { startElectronE2ESession } from './helpers/session-harness';
import {
    acknowledgeOcrResult,
    consumeOcrResultIntoActiveWorkspace,
    createWorkingCopyFromPath,
    runOcrSearchablePdf,
} from './helpers/electron-api-helpers';
import {
    waitForPdfLoaded,
    openPdfInApp,
} from './helpers/viewer-helpers';
import { evaluateInPage } from './helpers/page-runtime';

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

interface ISearchResponse {
    results: unknown[];
    truncated: boolean;
}

interface IOcrCleanupResult {cleaned: boolean;}

function expectDefined<T>(value: T | null | undefined, label: string): T {
    expect(value, `${label} should be defined`).toBeDefined();
    return value as T;
}

function expectString(value: unknown, label: string): string {
    expect(typeof value, `${label} should be a string`).toBe('string');
    return value as string;
}

function expectBoolean(value: unknown, label: string): boolean {
    expect(typeof value, `${label} should be a boolean`).toBe('boolean');
    return value as boolean;
}

function expectSearchResponse(value: unknown): ISearchResponse {
    expect(value).toEqual(expect.objectContaining({
        results: expect.any(Array),
        truncated: expect.any(Boolean),
    }));
    return value as ISearchResponse;
}

function expectCleanupResult(value: unknown, label: string): IOcrCleanupResult {
    expect(value, label).toEqual(expect.objectContaining({cleaned: expect.any(Boolean)}));
    return value as IOcrCleanupResult;
}

function expectSnapshotAt(snapshots: IPdfPageSnapshot[], index: number, label: string): IPdfPageSnapshot {
    return expectDefined(snapshots[index], label);
}

describe('Electron E2E - Phase 5 (OCR Pipeline)', () => {
    it('creates a searchable PDF, renders OCR text, and serves search matches', async () => {
        const sourcePath = copyProjectFixture('test-scanned.pdf', `phase5-scanned-${Date.now()}.pdf`);
        const session = await startElectronE2ESession(`e2e-phase5-${Date.now()}`);

        let ocrRequestId = '';
        let ocrPdfPath: string | null = null;
        let needsCleanupAck = false;
        let didAcknowledgeResult = false;

        try {
            await openPdfInApp(session.page, sourcePath);
            await waitForPdfLoaded(session.page);

            const workingCopyPath = expectString(
                await createWorkingCopyFromPath(session.page, sourcePath, sourcePath),
                'workingCopyPath',
            );
            expect(workingCopyPath.length).toBeGreaterThan(0);

            ocrRequestId = `ocr-e2e-${Date.now()}`;
            const ocrResult = await runOcrSearchablePdf(session.page, workingCopyPath, ocrRequestId);

            expect(ocrResult.started).toBe(true);
            expect(ocrResult.success).toBe(true);
            expect(ocrResult.pdfPath).toBeTruthy();
            expect(ocrResult.errors).toEqual([]);
            expect(ocrResult.startError).toBeNull();
            needsCleanupAck = Boolean(ocrResult.requiresCleanupAck);

            ocrPdfPath = ocrResult.pdfPath;
            if (!ocrPdfPath) {
                throw new Error('OCR did not return a PDF path');
            }

            const snapshots = await readPdfPageSnapshots(ocrPdfPath);
            expect(snapshots.length).toBeGreaterThan(0);
            const firstSnapshot = expectSnapshotAt(snapshots, 0, 'first OCR snapshot');
            expect(firstSnapshot.textSnippet.length).toBeGreaterThan(0);
            const query = pickSearchQuery(firstSnapshot.textSnippet);

            const applyResult = expectCleanupResult(
                await consumeOcrResultIntoActiveWorkspace(
                    session.page,
                    ocrRequestId,
                    ocrPdfPath,
                ),
                'OCR apply result',
            );
            didAcknowledgeResult = !needsCleanupAck || applyResult.cleaned;
            await waitForPdfLoaded(session.page);

            const textLayerSpanCount = await evaluateInPage(session.page, () => {
                const host = Array.from(document.querySelectorAll('.workspace-host'))
                    .find((candidate) => {
                        const element = candidate as HTMLElement;
                        const rect = element.getBoundingClientRect();
                        const style = window.getComputedStyle(element);
                        return style.display !== 'none' && rect.width > 100 && rect.height > 100;
                    }) as HTMLElement | undefined;
                if (!host) {
                    return 0;
                }
                return host.querySelectorAll('.text-layer span, .textLayer span').length;
            });
            expect(textLayerSpanCount).toBeGreaterThan(0);

            const warmed = expectBoolean(await evaluateInPage(session.page, async (
                searchablePath: string,
                requestId: string,
            ) => {
                const search = (window as Window & { electronAPI?: { search?: TSearchApi } }).electronAPI?.search;
                if (!search?.warmIndex) {
                    throw new Error('electronAPI.search.warmIndex is unavailable');
                }
                return search.warmIndex(searchablePath, {
                    requestId,
                    pageCount: 1,
                });
            }, workingCopyPath, `warm-${Date.now()}`), 'search warmIndex result');
            expect(warmed).toBe(true);

            const searchResponse = expectSearchResponse(await evaluateInPage(session.page, async (
                searchablePath: string,
                searchQuery: string,
                requestId: string,
            ) => {
                const search = (window as Window & { electronAPI?: { search?: TSearchApi } }).electronAPI?.search;
                if (!search?.run) {
                    throw new Error('electronAPI.search.run is unavailable');
                }
                return search.run(searchablePath, searchQuery, {
                    requestId,
                    pageCount: 1,
                });
            }, workingCopyPath, query, `search-${Date.now()}`));
            expect(searchResponse.results.length).toBeGreaterThan(0);

            if (needsCleanupAck && !didAcknowledgeResult) {
                const ack = expectCleanupResult(
                    await acknowledgeOcrResult(session.page, ocrRequestId, ocrPdfPath),
                    'OCR cleanup acknowledgement',
                );
                expect(ack.cleaned).toBe(true);
                didAcknowledgeResult = true;
            }
        } finally {
            if (ocrRequestId && ocrPdfPath && needsCleanupAck && !didAcknowledgeResult) {
                await acknowledgeOcrResult(session.page, ocrRequestId, ocrPdfPath).catch(() => undefined);
            }
            await session.stop();
        }
    });
});
