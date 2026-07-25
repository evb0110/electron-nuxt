import {createHash} from 'node:crypto';
import {
    open,
    readFile,
} from 'node:fs/promises';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import type {Page} from 'puppeteer-core';
import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import {
    createMultiPageTextFixturePdf,
    readPdfAnnotationSummary,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    startElectronE2ESession,
    type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {startConfiguredElectronE2ESession as startConfiguredSession} from '@tests/e2e/electron/helpers/startConfiguredElectronE2ESession';
import {
    openAnnotationsTab,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {createFreeTextAnnotation} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    callWorkspaceCommand,
    getLatestAutomationEventId,
    readWorkspaceStateValues,
    waitForAutomationEvent,
    waitForSaveFrontierReady,
    waitForWorkspaceToolbarIdle,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const E2E_TIMEOUT_MS = 180_000;
const SAVE_TIMEOUT_MS = 60_000;

interface ISaveReceiptProbe {
    barrierFinished: boolean;
    nativeProjectionEngaged: boolean;
    stagedArtifact: ITypedStagedArtifact | null;
}

interface IPdfSourceStateSnapshot {
    hasInMemoryData: boolean;
    reloadKind: 'blob' | 'none' | 'path';
    reloadPath: string | null;
}

interface ICommittedCanvasContinuitySnapshot {
    canvas: HTMLCanvasElement;
    canvasClassName: string;
    height: number;
    pageContainerClassName: string;
    width: number;
}

type TSaveReceiptProbeWindow = Window & {
    __committedCanvasContinuitySnapshot?: ICommittedCanvasContinuitySnapshot;
    __resumeSaveReceiptCommit?: () => void;
    __saveReceiptProbe?: ISaveReceiptProbe;
};

function hashBytes(bytes: Uint8Array) {
    return createHash('sha256')
        .update(bytes)
        .digest('hex');
}

async function hashFile(path: string) {
    return hashBytes(await readFile(path));
}

async function waitForOpenedPdf(page: Page, path: string) {
    const results = await Promise.allSettled([
        waitForAutomationEvent(page, 'document-opened', {
            path,
            timeoutMs: SAVE_TIMEOUT_MS,
        }),
        waitForAutomationEvent(page, 'first-page-rendered', {
            path,
            timeoutMs: SAVE_TIMEOUT_MS,
        }),
    ]);
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') {
        throw rejected.reason;
    }
    await waitForPdfLoaded(page, SAVE_TIMEOUT_MS);
    await waitForViewerInteractive(page, SAVE_TIMEOUT_MS);
}

async function createDirtyFreeText(page: Page, text: string) {
    await openAnnotationsTab(page, 30_000);
    expect(await createFreeTextAnnotation(page, text)).toBeGreaterThan(0);
    await waitForSaveFrontierReady(page);
}

async function createDirtyStickyNote(page: Page) {
    await openAnnotationsTab(page, 30_000);
    const created = await callWorkspaceCommand<boolean>(page, 'commentAtPoint', [
        1,
        0.72,
        0.24,
        {preferTextAnchor: false},
    ]);
    expect(created).toEqual({
        called: true,
        value: true,
    });
    await page.keyboard.press('Escape');
    await waitForWorkspaceToolbarIdle(page, {timeoutMs: 20_000});
    await waitForSaveFrontierReady(page);
}

async function saveFromWorkspace(page: Page, path: string) {
    const afterEventId = await getLatestAutomationEventId(page);
    const result = await callWorkspaceCommand<boolean>(page, 'handleSave');
    expect(result).toEqual({
        called: true,
        value: true,
    });
    await waitForAutomationEvent(page, 'save-committed', {
        afterEventId,
        path,
        timeoutMs: SAVE_TIMEOUT_MS,
    });
}

async function installReceiptProbe(page: Page, pauseCommit: boolean) {
    const installed = await page.evaluate((shouldPause) => {
        const probe: ISaveReceiptProbe = {
            barrierFinished: false,
            nativeProjectionEngaged: false,
            stagedArtifact: null,
        };
        const probeWindow = window as TSaveReceiptProbeWindow;
        probeWindow.__saveReceiptProbe = probe;
        let resumeCommit = () => {};
        const commitBarrier = shouldPause
            ? new Promise<void>((resolve) => {
                resumeCommit = resolve;
            })
            : Promise.resolve();
        probeWindow.__resumeSaveReceiptCommit = () => resumeCommit();
        const barrier = async (stagedArtifact: ITypedStagedArtifact) => {
            probe.nativeProjectionEngaged = true;
            probe.stagedArtifact = stagedArtifact;
            await commitBarrier;
            probe.barrierFinished = true;
        };
        probeWindow.__stagedPdfNativeMutationCommitBarrierForAutomation = barrier;
        return probeWindow.__stagedPdfNativeMutationCommitBarrierForAutomation === barrier;
    }, pauseCommit);
    expect(installed).toBe(true);
}

async function waitForStagedArtifact(page: Page) {
    await page.waitForFunction(
        () => (window as TSaveReceiptProbeWindow).__saveReceiptProbe?.stagedArtifact !== null,
        {timeout: SAVE_TIMEOUT_MS},
    );
    const artifact = await page.evaluate(
        () => (window as TSaveReceiptProbeWindow).__saveReceiptProbe?.stagedArtifact ?? null,
    );
    if (!artifact) {
        throw new Error('Native save did not expose a staged artifact to the receipt probe');
    }
    return artifact;
}

async function captureCommittedCanvasForSaveContinuity(page: Page) {
    return page.evaluate(() => {
        const pageContainer = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .page_container',
        );
        const canvas = pageContainer?.querySelector<HTMLCanvasElement>(
            '.page_canvas__render-layer canvas',
        );
        if (!pageContainer || !canvas || canvas.width <= 0 || canvas.height <= 0) {
            throw new Error('No committed PDF canvas was available before save');
        }
        const snapshot: ICommittedCanvasContinuitySnapshot = {
            canvas,
            canvasClassName: canvas.className,
            height: canvas.height,
            pageContainerClassName: pageContainer.className,
            width: canvas.width,
        };
        (window as TSaveReceiptProbeWindow).__committedCanvasContinuitySnapshot = snapshot;
        return {
            canvasClassName: snapshot.canvasClassName,
            height: snapshot.height,
            pageContainerClassName: snapshot.pageContainerClassName,
            rendered: pageContainer.classList.contains('page_container--rendered'),
            width: snapshot.width,
        };
    });
}

async function expectCommittedCanvasSurvivedSave(
    page: Page,
) {
    const continuity = await page.evaluate(() => {
        const snapshot = (window as TSaveReceiptProbeWindow).__committedCanvasContinuitySnapshot;
        if (!snapshot) {
            throw new Error('No committed PDF canvas continuity snapshot was captured before save');
        }
        const pageContainer = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .page_container',
        );
        const canvas = pageContainer?.querySelector<HTMLCanvasElement>(
            '.page_canvas__render-layer canvas',
        );
        if (!pageContainer || !canvas) {
            throw new Error('No committed PDF canvas was available after save');
        }
        return {
            height: canvas.height,
            rendered: pageContainer.classList.contains('page_container--rendered'),
            sameCanvasClassName: canvas.className === snapshot.canvasClassName,
            sameCanvasNode: canvas === snapshot.canvas,
            sameHeight: canvas.height === snapshot.height,
            samePageContainerClassName: pageContainer.className === snapshot.pageContainerClassName,
            sameWidth: canvas.width === snapshot.width,
            width: canvas.width,
        };
    });
    expect(continuity).toEqual({
        height: expect.any(Number),
        rendered: true,
        sameCanvasClassName: true,
        sameCanvasNode: true,
        sameHeight: true,
        samePageContainerClassName: true,
        sameWidth: true,
        width: expect.any(Number),
    });
    expect(continuity.height).toBeGreaterThan(0);
    expect(continuity.width).toBeGreaterThan(0);
}

async function isLinearizedPdf(path: string) {
    const bytes = await readFile(path);
    return bytes.subarray(0, Math.min(bytes.byteLength, 4096))
        .toString()
        .includes('/Linearized');
}

describe('Electron E2E - save pipeline diagnostics', () => {
    let session: IElectronE2ESession | null = null;
    const previousNativePageOps = process.env.EVB_PDF_PAGE_OPS_ENABLE;
    const previousOptimizeMinBytes = process.env.EVB_LARGE_PDF_SAVE_OPTIMIZE_MIN_BYTES;

    afterEach(async () => {
        await session?.page.evaluate(() => {
            const probeWindow = window as TSaveReceiptProbeWindow;
            probeWindow.__resumeSaveReceiptCommit?.();
            delete probeWindow.__stagedPdfNativeMutationCommitBarrierForAutomation;
        }).catch(() => undefined);
        if (session) {
            await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: SAVE_TIMEOUT_MS})
                .catch(() => undefined);
        }
        await session?.stop();
        session = null;
        if (previousNativePageOps === undefined) {
            delete process.env.EVB_PDF_PAGE_OPS_ENABLE;
        } else {
            process.env.EVB_PDF_PAGE_OPS_ENABLE = previousNativePageOps;
        }
        if (previousOptimizeMinBytes === undefined) {
            delete process.env.EVB_LARGE_PDF_SAVE_OPTIMIZE_MIN_BYTES;
        } else {
            process.env.EVB_LARGE_PDF_SAVE_OPTIMIZE_MIN_BYTES = previousOptimizeMinBytes;
        }
    });

    it('reuses an unchanged staged receipt and keeps the native save path-backed and live', async () => {
        process.env.EVB_PDF_PAGE_OPS_ENABLE = '1';
        const pdfPath = await createMultiPageTextFixturePdf(`save-receipt-reuse-${Date.now()}.pdf`, 2);
        session = await startElectronE2ESession(`e2e-save-receipt-reuse-${Date.now()}`, {
            clean: true,
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session.page, pdfPath);
        await installReceiptProbe(session.page, false);
        await createDirtyStickyNote(session.page);
        expect((await captureCommittedCanvasForSaveContinuity(session.page)).rendered).toBe(true);

        await saveFromWorkspace(session.page, pdfPath);
        await expectCommittedCanvasSurvivedSave(session.page);

        const probe = await session.page.evaluate(
            () => (window as TSaveReceiptProbeWindow).__saveReceiptProbe ?? null,
        );
        expect(probe?.stagedArtifact).toMatchObject({
            artifactKind: 'pdf',
            receiptVersion: 1,
        });
        expect(probe?.nativeProjectionEngaged).toBe(true);
        expect(probe?.barrierFinished).toBe(true);
        const sourceState = await readWorkspaceStateValues<{
            pdfSourceState?: IPdfSourceStateSnapshot;
            workingCopyPath?: string | null;
        }>(session.page, [
            'pdfSourceState',
            'workingCopyPath',
        ]);
        expect(sourceState.pdfSourceState).toEqual({
            hasInMemoryData: false,
            reloadKind: 'path',
            reloadPath: sourceState.workingCopyPath,
        });
        expect((await readPdfAnnotationSummary(pdfPath)).bySubtype.FreeText ?? 0).toBeGreaterThan(0);

        await createDirtyFreeText(session.page, `post-save free text ${Date.now()}`);
        expect((await captureCommittedCanvasForSaveContinuity(session.page)).rendered).toBe(true);
        await saveFromWorkspace(session.page, pdfPath);
        await waitForViewerInteractive(session.page, SAVE_TIMEOUT_MS);
        await expectCommittedCanvasSurvivedSave(session.page);
        expect((await readPdfAnnotationSummary(pdfPath)).bySubtype.FreeText ?? 0).toBeGreaterThan(1);

        const navigated = await callWorkspaceCommand(session.page, 'handleGoToPage', [2]);
        expect(navigated.called).toBe(true);
        await session.page.waitForFunction(
            () => window.__evbTestApi?.getActiveToolbarSnapshot()?.currentPage === 2,
            {timeout: 20_000},
        );
        await waitForViewerInteractive(session.page, 20_000);
    }, E2E_TIMEOUT_MS);

    it('invalidates a same-size drifted staged artifact before commit', async () => {
        process.env.EVB_PDF_PAGE_OPS_ENABLE = '1';
        const pdfPath = await createMultiPageTextFixturePdf(`save-receipt-drift-${Date.now()}.pdf`, 1);
        const beforeHash = await hashFile(pdfPath);
        session = await startElectronE2ESession(`e2e-save-receipt-drift-${Date.now()}`, {
            clean: true,
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session.page, pdfPath);
        await installReceiptProbe(session.page, true);
        await createDirtyStickyNote(session.page);

        const savePromise = callWorkspaceCommand<boolean>(session.page, 'handleSave').then(
            value => ({
                error: null,
                value,
            }),
            error => ({
                error,
                value: null,
            }),
        );
        let receiptProbeError: unknown = null;
        try {
            const stagedArtifact = await waitForStagedArtifact(session.page);
            const handle = await open(stagedArtifact.path, 'r+');
            try {
                const byte = Buffer.alloc(1);
                await handle.read(byte, 0, 1, 8);
                byte[0] = (byte[0] ?? 0) ^ 1;
                await handle.write(byte, 0, 1, 8);
                await handle.sync();
            } finally {
                await handle.close();
            }
        } catch (error) {
            receiptProbeError = error;
        }
        await session.page.evaluate(
            () => (window as TSaveReceiptProbeWindow).__resumeSaveReceiptCommit?.(),
        );
        const saveOutcome = await savePromise;
        if (saveOutcome.error) {
            throw saveOutcome.error;
        }
        if (receiptProbeError) {
            throw receiptProbeError;
        }
        await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: SAVE_TIMEOUT_MS});

        expect(saveOutcome.value?.called).toBe(true);
        expect(saveOutcome.value?.value).toBe(false);
        const probe = await session.page.evaluate(
            () => (window as TSaveReceiptProbeWindow).__saveReceiptProbe ?? null,
        );
        expect(probe?.nativeProjectionEngaged).toBe(true);
        expect(probe?.barrierFinished).toBe(true);
        expect(probe?.stagedArtifact).toMatchObject({
            artifactKind: 'pdf',
            receiptVersion: 1,
        });
        expect(await hashFile(pdfPath)).toBe(beforeHash);
    }, E2E_TIMEOUT_MS);

    it('skips low-tier ordinary linearization while preserving it for the high tier', async () => {
        process.env.EVB_LARGE_PDF_SAVE_OPTIMIZE_MIN_BYTES = '1';
        process.env.EVB_PDF_PAGE_OPS_ENABLE = '0';

        const lowPath = await createMultiPageTextFixturePdf(`save-tier-low-${Date.now()}.pdf`, 1);
        session = await startConfiguredSession(
            `e2e-save-tier-low-${Date.now()}`,
            'low',
            [lowPath],
        );
        await waitForOpenedPdf(session.page, lowPath);
        await createDirtyFreeText(session.page, `low tier ${Date.now()}`);
        await saveFromWorkspace(session.page, lowPath);
        expect(await isLinearizedPdf(lowPath)).toBe(false);
        await session.stop();
        session = null;

        const highPath = await createMultiPageTextFixturePdf(`save-tier-high-${Date.now()}.pdf`, 1);
        session = await startConfiguredSession(
            `e2e-save-tier-high-${Date.now()}`,
            'high',
            [highPath],
        );
        await waitForOpenedPdf(session.page, highPath);
        await createDirtyFreeText(session.page, `high tier ${Date.now()}`);
        await saveFromWorkspace(session.page, highPath);
        expect(await isLinearizedPdf(highPath)).toBe(true);
    }, E2E_TIMEOUT_MS);
});
