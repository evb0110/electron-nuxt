import {
    describe,
    expect,
    it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {createScannedTextFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {
    assertOcrPdfSemanticOutput,
    consumeOcrResultIntoActiveWorkspace,
    getActiveWorkspaceWorkingCopyPath,
    runOcrSearchablePdf,
} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';

const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-ocr-journey-${Date.now()}`});

describe('nightly OCR journey', () => {
    it('recognizes, applies, and reloads a scanned page through the real Electron API', async () => {
        const session = sessionFixture.getSession();
        expect(session).toBeTruthy();
        if (!session) {
            return;
        }

        const expectedText = 'EVB NIGHTLY OCR JOURNEY';
        const sourcePath = await createScannedTextFixturePdf(
            'ocr-journey-scanned.pdf',
            expectedText,
        );
        await openPdfInApp(session.page, sourcePath, 90_000);
        await waitForPdfLoaded(session.page, 90_000);
        await waitForViewerInteractive(session.page, 90_000);
        const workingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
        const requestId = `ocr-e2e-${Date.now()}`;
        const result = await runOcrSearchablePdf(
            session.page,
            workingCopyPath,
            requestId,
            expectedText,
        );

        expect(result).toMatchObject({
            started: true,
            success: true,
        });
        expect(result.progressEventCount).toBeGreaterThan(0);
        expect(result.pdfPath).toBeTruthy();
        expect(result.sourceDocumentRevisionToken).toBeTruthy();
        expect(result.recognizedText).toContain(expectedText);
        await consumeOcrResultIntoActiveWorkspace(
            session.page,
            requestId,
            result.pdfPath!,
            result.sourceDocumentRevisionToken!,
        );
        await waitForPdfLoaded(session.page, 90_000);
        await waitForViewerInteractive(session.page, 90_000);
        expect(await assertOcrPdfSemanticOutput(workingCopyPath, expectedText)).toContain(expectedText);
    }, 240_000);
});
