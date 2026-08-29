import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    createMultiPageTextFixturePdf,
    readPdfAnnotationSummary,
} from '@tests/e2e/electron/helpers/fixtures';
import {createFreeTextAnnotationWithPointer} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    openAnnotationsTab,
    saveViaWindowHandle,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    getLatestAutomationEventId,
    readWorkspaceStateValues,
    waitForAutomationEvent,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    startElectronE2ESession,
    type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';

const NATIVE_SAVE_REOPEN_TIMEOUT_MS = 120_000;

async function waitForOpenedPdf(session: IElectronE2ESession, path: string) {
    await Promise.all([
        waitForAutomationEvent(session.page, 'document-opened', {
            path,
            timeoutMs: 45_000,
        }),
        waitForAutomationEvent(session.page, 'first-page-rendered', {
            path,
            timeoutMs: 45_000,
        }),
    ]);
    await waitForPdfLoaded(session.page, 45_000);
    await waitForViewerInteractive(session.page, 45_000);
}

describe('Electron E2E - native save and reopen', () => {
    let session: IElectronE2ESession | null = null;

    afterEach(async () => {
        await session?.stop();
        session = null;
    });

    it('forces a renderer annotation save, on-disk receipt, and fresh-process reopen', async () => {
        const pdfPath = await createMultiPageTextFixturePdf(`native-save-reopen-${Date.now()}.pdf`, 2);
        const annotationText = `native save reopen ${Date.now()}`;

        session = await startElectronE2ESession(`e2e-native-save-reopen-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session, pdfPath);
        await openAnnotationsTab(session.page, 30_000);
        expect(await createFreeTextAnnotationWithPointer(session.page, annotationText, {
            x: 0.44,
            y: 0.38,
        })).toBeGreaterThan(0);
        await expect.poll(async () => (
            await readWorkspaceStateValues<{dirtyState?: {hasLivePdfJsAnnotationChanges?: boolean;}}>(
                session!.page,
                ['dirtyState'],
            )
        ).dirtyState?.hasLivePdfJsAnnotationChanges ?? false, {timeout: 20_000}).toBe(true);

        const saveBaselineEventId = await getLatestAutomationEventId(session.page);
        await saveViaWindowHandle(session.page, 60_000);
        await waitForAutomationEvent(session.page, 'save-committed', {
            afterEventId: saveBaselineEventId,
            path: pdfPath,
            timeoutMs: 60_000,
        });
        await expect.poll(async () => (
            await readWorkspaceStateValues<{dirtyState?: {
                fileDirty?: boolean;
                hasLivePdfJsAnnotationChanges?: boolean;
                hasPendingUnsavedChanges?: boolean;
            };}>(session!.page, ['dirtyState'])
        ).dirtyState, {timeout: 20_000}).toMatchObject({
            fileDirty: false,
            hasLivePdfJsAnnotationChanges: false,
            hasPendingUnsavedChanges: false,
        });
        expect((await readPdfAnnotationSummary(pdfPath)).bySubtype.FreeText ?? 0).toBeGreaterThan(0);

        const savedSession = session;
        session = null;
        await savedSession.stop();
        session = await startElectronE2ESession(`e2e-native-save-reopen-fresh-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session, pdfPath);
        expect((await readPdfAnnotationSummary(pdfPath)).bySubtype.FreeText ?? 0).toBeGreaterThan(0);
    }, NATIVE_SAVE_REOPEN_TIMEOUT_MS);
});
