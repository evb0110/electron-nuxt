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

describe('Electron E2E - Phase 5 (OCR Pipeline)', () => {
    it('creates a searchable PDF and renders text layer from OCR output', async () => {
        const sourcePath = copyProjectFixture('test-scanned.pdf', `phase5-scanned-${Date.now()}.pdf`);
        const session = await startElectronE2ESession(`e2e-phase5-${Date.now()}`);

        let ocrRequestId = '';
        let ocrPdfPath: string | null = null;

        try {
            await openPdfInApp(session.page, sourcePath);
            await waitForPdfLoaded(session.page);

            const workingCopyPath = await createWorkingCopyFromPath(session.page, sourcePath, sourcePath);
            expect(workingCopyPath.length).toBeGreaterThan(0);

            ocrRequestId = `ocr-e2e-${Date.now()}`;
            const ocrResult = await runOcrSearchablePdf(session.page, workingCopyPath, ocrRequestId);

            expect(ocrResult.started).toBe(true);
            expect(ocrResult.success).toBe(true);
            expect(ocrResult.pdfPath).toBeTruthy();
            expect(ocrResult.errors).toEqual([]);
            expect(ocrResult.startError).toBeNull();

            ocrPdfPath = ocrResult.pdfPath;
            if (!ocrPdfPath) {
                throw new Error('OCR did not return a PDF path');
            }

            const snapshots = await readPdfPageSnapshots(ocrPdfPath);
            expect(snapshots.length).toBeGreaterThan(0);
            expect(snapshots[0]?.textSnippet.length ?? 0).toBeGreaterThan(0);

            await openPdfInApp(session.page, ocrPdfPath);
            await waitForPdfLoaded(session.page);

            const textLayerSpanCount = await session.page.evaluate(() => {
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
