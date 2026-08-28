import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {
    open,
    readFile,
} from 'node:fs/promises';
import {promisify} from 'node:util';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import type {Page} from 'puppeteer-core';
import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import {findSessionOwnedElectronPids} from '@scripts/electron-run/electronRunProcessIdentity';
import {
    collectDescendantPidsUnix,
    isProcessAlive,
} from '@scripts/electron-run/electronRunProcessTree';
import {getSessionInfo} from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    createMultiPageTextFixturePdf,
    readPdfAnnotationSummary,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    startElectronE2ESession,
    type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    openAnnotationsTab,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    waitForAnimationFrames,
    waitForVisibleMountedPdfCanvases,
} from '@tests/e2e/electron/helpers/viewerVirtualizationContract';
import {
    installCommittedSurfaceSampler,
    markCommittedSurfaceInteractionCheckpoint,
    stopCommittedSurfaceSampler,
} from '@tests/e2e/electron/helpers/viewerCommittedSurfaceContract';
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
    await waitForVisibleMountedPdfCanvases(page, SAVE_TIMEOUT_MS);
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

function expectVisiblePdfPagesStayedPainted(
    trace: Awaited<ReturnType<typeof stopCommittedSurfaceSampler>>,
) {
    expect(trace.errors ?? []).toEqual([]);
    expect(trace.frames.length).toBeGreaterThan(0);
    expect(trace.frames.some(frame => frame.interactionCheckpoint === 'save-committed')).toBe(true);
    const failures = trace.frames.flatMap((frame) => {
        const visiblePages = frame.visiblePdfPageVisuals ?? [];
        const stayedPainted = ![
            'blank',
            'loader',
            'neutral',
        ].includes(frame.kind)
            && frame.outOfFrameSkeletonCount === 0
            && visiblePages.length > 0
            && visiblePages.every(pageVisual => (
                !pageVisual.skeletonVisible
                && (
                    (
                        pageVisual.canonicalCanvasVisible
                        && pageVisual.canonicalCanvasNonblank
                    )
                    || (
                        pageVisual.resizeSnapshotVisible
                        && pageVisual.resizeSnapshotNonblank
                    )
                )
            ));
        return stayedPainted
            ? []
            : [{
                elapsedMs: frame.elapsedMs,
                frame: frame.frame,
                kind: frame.kind,
                visiblePages,
            }];
    });
    expect(failures).toEqual([]);
}

async function stopSaveVisualContinuitySampler(page: Page) {
    await markCommittedSurfaceInteractionCheckpoint(page, 'save-committed');
    await waitForAnimationFrames(page, 2);
    return stopCommittedSurfaceSampler(page);
}

async function expectCommittedCanvasSurvivedSave(
    page: Page,
) {
    await waitForVisibleMountedPdfCanvases(page, SAVE_TIMEOUT_MS);
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
        sameHeight: true,
        samePageContainerClassName: true,
        sameWidth: true,
        width: expect.any(Number),
    });
    expect(continuity.height).toBeGreaterThan(0);
    expect(continuity.width).toBeGreaterThan(0);
}

const execFileAsync = promisify(execFile);

function readSessionProcessTree(sessionName: string) {
    const info = getSessionInfo(sessionName);
    if (!info) {
        throw new Error(`Electron E2E session '${sessionName}' has no session metadata`);
    }
    const roots = [
        info.pid,
        ...(info.electronPid ? [info.electronPid] : []),
    ];
    return [...new Set(roots.flatMap(pid => [
        pid,
        ...collectDescendantPidsUnix(pid),
    ]))];
}

// `lsof -t` exits 1 when no process holds any of the paths.
async function readOpenHandlePids(paths: readonly string[]) {
    try {
        const {stdout} = await execFileAsync('lsof', [
            '-t',
            '--',
            ...paths,
        ]);
        return stdout.split('\n').map(Number).filter(pid => Number.isInteger(pid) && pid > 0);
    } catch (error) {
        const failure = error as {
            code?: number | string;
            stdout?: string;
        };
        if (Number(failure.code) === 1 && !failure.stdout?.trim()) {
            return [];
        }
        throw error;
    }
}

async function isLinearizedPdf(path: string) {
    const bytes = await readFile(path);
    return bytes.subarray(0, Math.min(bytes.byteLength, 4096))
        .toString()
        .includes('/Linearized');
}

describe('Electron E2E - save pipeline diagnostics', () => {
    let session: IElectronE2ESession | null = null;

    afterEach(async () => {
        await session?.page.evaluate(() => {
            const probeWindow = window as TSaveReceiptProbeWindow;
            probeWindow.__resumeSaveReceiptCommit?.();
            delete probeWindow.__stagedPdfNativeMutationCommitBarrierForAutomation;
        }).catch(() => undefined);
        if (session) {
            await stopCommittedSurfaceSampler(session.page).catch(() => undefined);
        }
        if (session) {
            await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: SAVE_TIMEOUT_MS})
                .catch(() => undefined);
        }
        await session?.stop();
        session = null;
    });

    it('reuses an unchanged staged receipt and keeps the native save path-backed and live', async () => {
        const pdfPath = await createMultiPageTextFixturePdf(`save-receipt-reuse-${Date.now()}.pdf`, 2);
        session = await startElectronE2ESession(`e2e-save-receipt-reuse-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session.page, pdfPath);
        await installReceiptProbe(session.page, false);
        await createDirtyStickyNote(session.page);
        expect((await captureCommittedCanvasForSaveContinuity(session.page)).rendered).toBe(true);

        await installCommittedSurfaceSampler(session.page);
        await saveFromWorkspace(session.page, pdfPath);
        const firstSaveVisualTrace = await stopSaveVisualContinuitySampler(session.page);
        expectVisiblePdfPagesStayedPainted(firstSaveVisualTrace);
        await expectCommittedCanvasSurvivedSave(session.page);

        const probe = await session.page.evaluate(
            () => (window as TSaveReceiptProbeWindow).__saveReceiptProbe ?? null,
        );
        expect(probe?.stagedArtifact).toMatchObject({
            artifactKind: 'pdf',
            receiptVersion: 2,
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

        await createDirtyStickyNote(session.page);
        expect((await captureCommittedCanvasForSaveContinuity(session.page)).rendered).toBe(true);
        await installCommittedSurfaceSampler(session.page);
        await saveFromWorkspace(session.page, pdfPath);
        await waitForViewerInteractive(session.page, SAVE_TIMEOUT_MS);
        const secondSaveVisualTrace = await stopSaveVisualContinuitySampler(session.page);
        expectVisiblePdfPagesStayedPainted(secondSaveVisualTrace);
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

    it.runIf(process.platform !== 'win32')(
        'leaves no process, handle, or partial write behind when the app is stopped hard mid-save',
        async () => {
            const pdfPath = await createMultiPageTextFixturePdf(`save-interrupt-residue-${Date.now()}.pdf`, 1);
            const beforeHash = await hashFile(pdfPath);
            session = await startElectronE2ESession(`e2e-save-interrupt-${Date.now()}`, {
                clean: true,
                extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
                initialOpenPaths: [pdfPath],
            });
            await waitForOpenedPdf(session.page, pdfPath);
            await installReceiptProbe(session.page, true);
            await createDirtyStickyNote(session.page);

            // The commit barrier holds the save with its staged artifact and
            // lease live, which is the state a hard stop must not leak.
            const savePromise = callWorkspaceCommand<boolean>(session.page, 'handleSave').then(
                value => ({
                    error: null,
                    value,
                }),
                (error: unknown) => ({
                    error,
                    value: null,
                }),
            );
            const stagedArtifact = await waitForStagedArtifact(session.page);
            expect(existsSync(stagedArtifact.path)).toBe(true);
            const processTree = readSessionProcessTree(session.name);
            expect(processTree.length).toBeGreaterThan(1);

            const interrupted = session;
            session = null;
            await interrupted.browser.disconnect();
            await interrupted.stop({crashElectronBeforeStop: true});
            const saveOutcome = await savePromise;

            const survivors = processTree.filter(isProcessAlive);
            const sessionOwned = findSessionOwnedElectronPids({
                kind: 'electron',
                sessionName: interrupted.name,
            });
            const openHandles = await readOpenHandlePids([
                pdfPath,
                stagedArtifact.path,
            ]);
            const afterHash = await hashFile(pdfPath);
            const diagnostics = JSON.stringify({
                afterHash,
                beforeHash,
                openHandles,
                processTree,
                saveOutcome: saveOutcome.error instanceof Error ? saveOutcome.error.message : saveOutcome,
                sessionOwned,
                stagedArtifactPath: stagedArtifact.path,
                stagedArtifactRemains: existsSync(stagedArtifact.path),
                survivors,
            }, null, 2);
            expect(survivors, diagnostics).toEqual([]);
            expect(sessionOwned, diagnostics).toEqual([]);
            expect(openHandles, diagnostics).toEqual([]);
            expect(afterHash, diagnostics).toBe(beforeHash);

            session = await startElectronE2ESession(`e2e-save-interrupt-reopen-${Date.now()}`, {
                clean: true,
                extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
                initialOpenPaths: [pdfPath],
            });
            await waitForOpenedPdf(session.page, pdfPath);
            expect((await readPdfAnnotationSummary(pdfPath)).bySubtype.FreeText ?? 0).toBe(0);
        },
        E2E_TIMEOUT_MS,
    );

    it('invalidates a same-size drifted staged artifact before commit', async () => {
        const pdfPath = await createMultiPageTextFixturePdf(`save-receipt-drift-${Date.now()}.pdf`, 1);
        const beforeHash = await hashFile(pdfPath);
        session = await startElectronE2ESession(`e2e-save-receipt-drift-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
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
            receiptVersion: 2,
        });
        expect(await hashFile(pdfPath)).toBe(beforeHash);
    }, E2E_TIMEOUT_MS);

    it('skips low-tier ordinary linearization while preserving it for the high tier', async () => {
        const tierSessionEnv = {
            EVB_LARGE_PDF_SAVE_OPTIMIZE_MIN_BYTES: '1',
            EVB_PDF_PAGE_OPS_ENABLE: '0',
        };

        const lowPath = await createMultiPageTextFixturePdf(`save-tier-low-${Date.now()}.pdf`, 1);
        session = await startConfiguredSession(
            `e2e-save-tier-low-${Date.now()}`,
            'low',
            tierSessionEnv,
        );
        await openPdfInApp(session.page, lowPath, SAVE_TIMEOUT_MS);
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
            tierSessionEnv,
        );
        await openPdfInApp(session.page, highPath, SAVE_TIMEOUT_MS);
        await waitForOpenedPdf(session.page, highPath);
        await createDirtyFreeText(session.page, `high tier ${Date.now()}`);
        await saveFromWorkspace(session.page, highPath);
        expect(await isLinearizedPdf(highPath)).toBe(true);
    }, E2E_TIMEOUT_MS);
});
