import {
    existsSync,
    statSync,
} from 'node:fs';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    createLargeScannedFixturePdf,
    readPdfPageSnapshots,
} from '@tests/e2e/electron/helpers/fixtures';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    clickVisibleToolbarButton,
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    type IWorkspaceExposeProbeWindow,
    readWorkspaceStateValues,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import type {IE2EWindow} from '@tests/e2e/electron/helpers/e2EWindow';
import {
    findCommittedSurfaceContractViolations,
    installCommittedSurfaceSampler,
    markCommittedSurfaceInteractionCheckpoint,
    stopCommittedSurfaceSampler,
} from '@tests/e2e/electron/helpers/viewerCommittedSurfaceContract';

interface ICommittedSurfaceProbeFrame {
    interactionCheckpoint?: string | null;
    kind: string;
}

interface ICommittedSurfaceProbeWindow extends Window {__committedSurfaceFrames?: ICommittedSurfaceProbeFrame[];}

const sessionFixture = createElectronE2ESessionFixture({
    sessionName: () => `e2e-scan-cleanup-journey-${Date.now()}`,
    windowMode: 'hidden',
});

describe('nightly scan cleanup journey', () => {
    it('detects and cleans a scanned page into a readable generated PDF', async () => {
        const session = sessionFixture.getSession();
        expect(session).toBeTruthy();
        if (!session) {
            return;
        }

        const sourcePath = await createLargeScannedFixturePdf(
            'scan-cleanup-journey.pdf',
            1,
            0,
        );
        await openPdfInApp(session.page, sourcePath, 90_000);
        await waitForPdfLoaded(session.page, 90_000);
        await waitForViewerInteractive(session.page, 90_000);
        await waitForFunctionInPage(session.page, () => {
            const api = (window as IWorkspaceExposeProbeWindow).__evbTestApi;
            const toolbar = api?.getActiveToolbarSnapshot?.();
            const identity = api?.readActiveWorkspaceStateValues?.(['workingCopyPath']);
            return toolbar?.initialVisualReady === true
                && toolbar.viewerCapabilities.pdfMutationActions === true
                && toolbar.isOpeningDocument === false
                && toolbar.isAnySaving === false
                && toolbar.isHistoryBusy === false
                && toolbar.totalPages > 0
                && typeof identity?.workingCopyPath === 'string';
        }, {timeout: 90_000});

        await clickVisibleToolbarButton(session.page, 'Scan cleanup');
        await session.page.waitForSelector('.scan-cleanup-surface', {
            timeout: 10_000,
            visible: true,
        });
        await waitForFunctionInPage(session.page, () => {
            const classification = document.querySelector<HTMLElement>(
                '.scan-thumbnail-overlay[data-classification]',
            )?.dataset.classification;
            const action = document.querySelector<HTMLButtonElement>(
                '.scan-cleanup-toolbar-primary-action',
            );
            return Boolean(
                classification === 'single'
                && action
                && !action.disabled,
            );
        }, {timeout: 90_000});

        await installCommittedSurfaceSampler(session.page);
        await markCommittedSurfaceInteractionCheckpoint(session.page, 'scan-cleanup-tool');
        await waitForFunctionInPage(session.page, () => {
            const frames = (window as ICommittedSurfaceProbeWindow).__committedSurfaceFrames ?? [];
            return frames.filter(frame => (
                frame.interactionCheckpoint === 'scan-cleanup-tool'
                && frame.kind === 'tool-surface'
            )).length >= 5;
        }, {timeout: 10_000});
        await markCommittedSurfaceInteractionCheckpoint(session.page, 'scan-cleanup-handoff');
        await session.page.click('.scan-cleanup-toolbar-primary-action');
        await waitForFunctionInPage(session.page, (source: string) => {
            const active = (window as IWorkspaceExposeProbeWindow)
                .__evbTestApi
                ?.readActiveWorkspaceStateValues?.(['originalPath']);
            return typeof active?.originalPath === 'string'
                && active.originalPath !== source
                && active.originalPath.endsWith('— cleaned.pdf');
        }, {timeout: 240_000}, sourcePath);
        await waitForFunctionInPage(session.page, () => Array.from(
            document.querySelectorAll<HTMLElement>('[data-slot="title"]'),
        ).some(title => (title.textContent ?? '').trim() === 'Scan cleanup complete'), {timeout: 30_000});
        await waitForPdfLoaded(session.page, 90_000);
        await waitForViewerInteractive(session.page, 90_000);
        await markCommittedSurfaceInteractionCheckpoint(session.page, 'scan-cleanup-output');
        await waitForFunctionInPage(session.page, () => {
            const frames = (window as ICommittedSurfaceProbeWindow).__committedSurfaceFrames ?? [];
            return frames.filter(frame => (
                frame.interactionCheckpoint === 'scan-cleanup-output'
                && frame.kind === 'committed-canvas'
            )).length >= 10;
        }, {timeout: 10_000});

        const outputState = await readWorkspaceStateValues(session.page, [
            'dirtyState',
            'originalPath',
            'requiresSaveAsOnFirstSave',
        ]);
        const outputPath = typeof outputState.originalPath === 'string'
            ? outputState.originalPath
            : null;
        expect(outputPath).toBeTruthy();
        expect(outputPath).not.toBe(sourcePath);
        expect(outputPath).toMatch(/— cleaned\.pdf$/u);
        expect(existsSync(outputPath!)).toBe(true);
        expect(statSync(outputPath!).size).toBeGreaterThan(0);
        expect(outputState.requiresSaveAsOnFirstSave).toBe(true);
        expect(outputState.dirtyState).toMatchObject({fileDirty: true});
        const handoffTrace = await stopCommittedSurfaceSampler(session.page);
        expect(findCommittedSurfaceContractViolations(handoffTrace)).toEqual([]);
        expect(handoffTrace.frames.filter(frame => frame.kind === 'tool-surface').length)
            .toBeGreaterThanOrEqual(5);
        expect(handoffTrace.frames.filter(frame => (
            frame.interactionCheckpoint === 'scan-cleanup-output'
            && frame.kind === 'committed-canvas'
        )).length).toBeGreaterThanOrEqual(10);
        const handoffStart = handoffTrace.frames.findIndex(
            frame => frame.interactionCheckpoint === 'scan-cleanup-handoff',
        );
        expect(handoffStart).toBeGreaterThanOrEqual(0);
        const transitionFrames = handoffTrace.frames.slice(handoffStart);
        expect(transitionFrames.some(frame => frame.kind === 'committed-canvas')).toBe(true);
        expect(transitionFrames.filter(frame => [
            'blank',
            'committed-empty',
            'loader',
            'neutral',
        ].includes(frame.kind))).toEqual([]);
        const firstDocumentFrame = transitionFrames.findIndex(frame => (
            frame.kind === 'page-shell' || frame.kind === 'committed-canvas'
        ));
        expect(firstDocumentFrame).toBeGreaterThanOrEqual(0);
        expect(transitionFrames.slice(firstDocumentFrame).some(frame => frame.kind === 'tool-surface'))
            .toBe(false);
        await waitForFunctionInPage(session.page, async (source: string) => {
            const recents = await (window as IE2EWindow)
                .electronAPI
                ?.documentRecentFiles
                ?.recentFiles
                .get() ?? [];
            return recents.some(recent => recent.originalPath === source);
        }, {timeout: 10_000}, sourcePath);
        const recentPaths = await session.page.evaluate(async () => (
            await (window as IE2EWindow)
                .electronAPI
                ?.documentRecentFiles
                ?.recentFiles
                .get() ?? []
        ).map(recent => recent.originalPath));
        expect(recentPaths).toContain(sourcePath);
        expect(recentPaths).not.toContain(outputPath);
        expect(await readPdfPageSnapshots(outputPath!)).toEqual([{
            pageNumber: 1,
            rotation: 0,
            textSnippet: '',
        }]);
    }, 360_000);
});
