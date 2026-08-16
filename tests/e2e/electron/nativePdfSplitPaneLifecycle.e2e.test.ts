import {
    describe,
    expect,
    it,
} from 'vitest';
import {getDocumentMutationErrorPayload} from '@contracts/documentMutationErrors';
import {
    resolveNativeLargePdfFixtureAvailability,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type {IElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    getActiveWorkspaceWorkingCopyPath,
    rotatePages,
} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {
    openNativePdfPreviewInApp,
    triggerOpenPathInApp,
} from '@tests/e2e/electron/helpers/viewerCore';
import {splitActiveWorkspaceDocument} from '@tests/e2e/electron/helpers/workspaceTabs';
import {
    callWorkspaceCommand,
    getWorkspaceToolbarSnapshot,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const LIFECYCLE_TIMEOUT_MS = 360_000;
const MUTATION_SETTLE_TIMEOUT_MS = 60_000;
const SOURCE_PANE_COUNT = 4;
const sourceFixture = resolveNativeLargePdfFixtureAvailability(1);
const successorFixture = resolveNativeLargePdfFixtureAvailability(3);
const lifecycleFixture = sourceFixture.path ? successorFixture : sourceFixture;
const lifecycleDescribe = selectFixtureDescribe(describe, lifecycleFixture);

interface INativePaneState {
    active: boolean;
    committed: boolean;
    currentPage: number;
    errorTexts: string[];
    imageHeight: number;
    imageReady: boolean;
    imageSource: string;
    imageWidth: number;
    paneId: string;
    phase: string;
    presentation: string;
    shellCount: number;
    skeletonVisible: boolean;
    tabId: string;
    viewportLifecycle: string;
}

interface IPendingOpenOwner {
    paneId: string;
    tabCount: number;
    tabId: string;
}

type TNativeLifecycleWindow = Window & {__readNativeSplitLifecyclePanes?: () => INativePaneState[];};

async function installNativePaneStateProbe(session: IElectronE2ESession) {
    await session.page.evaluate(() => {
        (window as TNativeLifecycleWindow).__readNativeSplitLifecyclePanes = () => {
            const isVisible = (element: HTMLElement | null) => {
                if (!element?.isConnected) {
                    return false;
                }
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return rect.width > 0
                    && rect.height > 0
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0;
            };

            return Array.from(document.querySelectorAll<HTMLElement>('.editor-pane'))
                .flatMap((pane) => {
                    const hosts = Array.from(pane.querySelectorAll<HTMLElement>('.workspace-host'));
                    const host = hosts.find(candidate => candidate.dataset.workspaceActive === 'true')
                        ?? hosts.find(isVisible)
                        ?? null;
                    const container = host?.querySelector<HTMLElement>('.native-pdf-viewer-container') ?? null;
                    const chassis = host?.querySelector<HTMLElement>('.document-viewer-chassis') ?? null;
                    const viewport = chassis?.querySelector<HTMLElement>('[data-open-surface-phase]') ?? null;
                    if (!host || !container || !chassis || !viewport || !isVisible(pane) || !isVisible(container)) {
                        return [];
                    }
                    const currentPage = Number(chassis.dataset.chassisCurrentPage ?? 0);
                    const shell = container.querySelector<HTMLElement>(
                        `.native-pdf-page-shell[data-page-number="${String(currentPage)}"]`,
                    );
                    const image = shell?.querySelector<HTMLImageElement>('.native-pdf-page-image') ?? null;
                    const committed = shell?.querySelector('.document-page-visual--committed') !== null;
                    const errorTexts = Array.from(host.querySelectorAll<HTMLElement>([
                        '[data-testid="native-pdf-viewer-error"]',
                        '[data-testid="workspace-document-pdf-error"]',
                        '.native-pdf-page-placeholder',
                    ].join(',')))
                        .filter(isVisible)
                        .map(element => (element.textContent ?? '').trim())
                        .filter(Boolean);
                    return [{
                        active: pane.classList.contains('is-active'),
                        committed,
                        currentPage,
                        errorTexts,
                        imageHeight: image?.naturalHeight ?? 0,
                        imageReady: Boolean(image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0),
                        imageSource: image?.currentSrc || image?.src || '',
                        imageWidth: image?.naturalWidth ?? 0,
                        paneId: pane.dataset.editorPaneId ?? '',
                        phase: viewport.dataset.openSurfacePhase ?? '',
                        presentation: chassis.dataset.openSurfacePresentation ?? '',
                        shellCount: container.querySelectorAll('.native-pdf-page-shell').length,
                        skeletonVisible: Boolean(shell?.querySelector('.document-page-skeleton')),
                        tabId: pane.querySelector<HTMLElement>('.tab.is-active')?.dataset.tabId ?? '',
                        viewportLifecycle: chassis.dataset.viewportLifecycle ?? '',
                    }];
                });
        };
    });
}

async function readNativePaneStates(session: IElectronE2ESession) {
    return session.page.evaluate(() => (
        (window as TNativeLifecycleWindow).__readNativeSplitLifecyclePanes?.() ?? []
    ));
}

async function waitForNativePanesReady(session: IElectronE2ESession, expectedCount: number) {
    await session.page.waitForFunction((count: number) => {
        const states = (window as TNativeLifecycleWindow).__readNativeSplitLifecyclePanes?.() ?? [];
        return states.length === count && states.every(state => (
            state.committed
            && state.currentPage >= 1
            && state.errorTexts.length === 0
            && state.imageReady
            && state.imageSource.startsWith('blob:')
            && state.phase === 'ready'
            && state.presentation === 'committed'
            && state.shellCount > 0
            && state.viewportLifecycle === 'ready'
        ));
    }, {timeout: LIFECYCLE_TIMEOUT_MS}, expectedCount);
    return readNativePaneStates(session);
}

async function activatePane(session: IElectronE2ESession, paneId: string) {
    await session.page.evaluate((targetPaneId: string) => {
        const pane = document.querySelector<HTMLElement>(
            `.editor-pane[data-editor-pane-id="${CSS.escape(targetPaneId)}"]`,
        );
        pane?.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
    }, paneId);
    await session.page.waitForFunction((targetPaneId: string) => (
        document.querySelector<HTMLElement>('.editor-pane.is-active')?.dataset.editorPaneId === targetPaneId
    ), {timeout: 30_000}, paneId);
}

async function openSourceInActivePane(
    session: IElectronE2ESession,
    sourcePath: string,
    expectedPaneCount: number,
) {
    await triggerOpenPathInApp(session.page, sourcePath, LIFECYCLE_TIMEOUT_MS);
    await waitForNativePanesReady(session, expectedPaneCount);
}

async function setActiveNativeZoom(session: IElectronE2ESession, paneId: string) {
    const before = (await readNativePaneStates(session)).find(state => state.paneId === paneId);
    expect(before?.active).toBe(true);
    const result = await callWorkspaceCommand(session.page, 'setCustomZoomFromDisplay', [5.03]);
    expect(result.called).toBe(true);
    await waitForWorkspaceToolbarSnapshot(session.page, {
        minEffectiveZoom: 5.03,
        zoomMode: 'custom',
    });
    await session.page.waitForFunction((targetPaneId: string) => {
        const state = (window as TNativeLifecycleWindow)
            .__readNativeSplitLifecyclePanes?.()
            .find(candidate => candidate.paneId === targetPaneId);
        return Boolean(
            state
            && state.active
            && state.committed
            && state.errorTexts.length === 0
            && state.imageReady
            && state.imageWidth >= 3_000
            && state.phase === 'ready'
            && state.presentation === 'committed'
            && state.viewportLifecycle === 'ready',
        );
    }, {timeout: LIFECYCLE_TIMEOUT_MS}, paneId);
}

async function waitForPendingOpenOwner(session: IElectronE2ESession, paneId: string) {
    await getWorkspaceToolbarSnapshot(session.page);
    await session.page.waitForFunction((targetPaneId: string) => {
        type TOpenClaimWindow = Window & {__evbTestApi?: {getActiveToolbarSnapshot?: () => {isOpeningDocument?: boolean} | null;};};
        const activePane = document.querySelector<HTMLElement>('.editor-pane.is-active');
        return activePane?.dataset.editorPaneId === targetPaneId
            && (window as TOpenClaimWindow).__evbTestApi?.getActiveToolbarSnapshot?.()?.isOpeningDocument === true;
    }, {timeout: MUTATION_SETTLE_TIMEOUT_MS}, paneId);
    return session.page.evaluate((targetPaneId: string) => {
        const pane = document.querySelector<HTMLElement>(
            `.editor-pane[data-editor-pane-id="${CSS.escape(targetPaneId)}"]`,
        );
        return {
            paneId: targetPaneId,
            tabCount: pane?.querySelectorAll('.tab').length ?? 0,
            tabId: pane?.querySelector<HTMLElement>('.tab.is-active')?.dataset.tabId ?? '',
        };
    }, paneId);
}

async function closeClaimedOpenTab(
    session: IElectronE2ESession,
    owner: IPendingOpenOwner,
) {
    expect(owner.tabId).not.toBe('');
    const expectedPaneCount = owner.tabCount > 1 ? SOURCE_PANE_COUNT : SOURCE_PANE_COUNT - 1;
    const clicked = await session.page.evaluate((target: {
        paneId: string;
        tabId: string;
    }) => {
        const close = document.querySelector<HTMLButtonElement>(
            `.editor-pane[data-editor-pane-id="${CSS.escape(target.paneId)}"] .tab[data-tab-id="${CSS.escape(target.tabId)}"] .tab-close`,
        );
        close?.click();
        return close !== null;
    }, owner);
    expect(clicked).toBe(true);
    await session.page.waitForFunction((count: number) => (
        document.querySelectorAll('.editor-pane').length === count
    ), {timeout: 30_000}, expectedPaneCount);
    return expectedPaneCount;
}

async function exerciseCurrentPageEviction(session: IElectronE2ESession) {
    return session.page.evaluate(async () => {
        type TPressureWindow = Window & {
            __getWorkspaceSurfaceBudgetForE2E?: () => {
                maxBytes: number;
                pressureLevel: string;
                reservedBytes: number;
                reservedBytesByCategory: Record<string, number>;
            };
            __setWorkspaceSurfacePressureForE2E?: (
                level: 'healthy' | 'post-crash-safe-mode',
            ) => void;
        };
        interface IFrame {
            panes: INativePaneState[];
            timeMs: number;
        }
        const pressureWindow = window as TPressureWindow;
        if (!pressureWindow.__setWorkspaceSurfacePressureForE2E || !pressureWindow.__getWorkspaceSurfaceBudgetForE2E) {
            throw new Error('Workspace surface pressure E2E hook is unavailable');
        }
        const readPaneStates = (window as TNativeLifecycleWindow).__readNativeSplitLifecyclePanes;
        if (!readPaneStates) {
            throw new Error('Native split lifecycle state probe is unavailable');
        }
        const before = readPaneStates();
        const beforeSources = new Map(before.map(state => [
            state.paneId,
            state.imageSource,
        ]));
        const beforeBudget = pressureWindow.__getWorkspaceSurfaceBudgetForE2E();
        const frames: IFrame[] = [];
        let frameId = 0;
        let timeoutId = 0;
        try {
            const observedEviction = await new Promise<boolean>((resolve) => {
                const sample = () => {
                    const panes = readPaneStates();
                    frames.push({
                        panes,
                        timeMs: Math.round(performance.now()),
                    });
                    const changed = panes.some(state => (
                        state.skeletonVisible
                        || !state.imageReady
                        || state.imageSource !== beforeSources.get(state.paneId)
                    ));
                    if (changed) {
                        resolve(true);
                        return;
                    }
                    frameId = requestAnimationFrame(sample);
                };
                timeoutId = window.setTimeout(() => resolve(false), 20_000);
                frameId = requestAnimationFrame(sample);
                pressureWindow.__setWorkspaceSurfacePressureForE2E?.('post-crash-safe-mode');
            });
            const pressureBudget = pressureWindow.__getWorkspaceSurfaceBudgetForE2E();
            return {
                before,
                beforeBudget,
                frames,
                observedEviction,
                pressureBudget,
            };
        } finally {
            cancelAnimationFrame(frameId);
            clearTimeout(timeoutId);
            pressureWindow.__setWorkspaceSurfacePressureForE2E('healthy');
        }
    });
}

lifecycleDescribe('Electron E2E - Native PDF split-pane lifecycle', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-native-pdf-split-lifecycle-${Date.now()}`,
        timeoutMs: LIFECYCLE_TIMEOUT_MS,
    });

    it('keeps same-path native panes revision-fenced through supersession and eviction while typed search and scan failures stay unit-pinned', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Native split-pane Electron E2E session failed to start');
        }
        if (!sourceFixture.path || !successorFixture.path) {
            throw new Error(`Native split-pane fixture unavailable: ${lifecycleFixture.reason}`);
        }

        await session.page.setViewport({
            deviceScaleFactor: 2,
            height: 1_200,
            width: 4_000,
        });
        await installNativePaneStateProbe(session);
        await openSourceInActivePane(session, sourceFixture.path, 1);
        for (let paneIndex = 1; paneIndex < SOURCE_PANE_COUNT; paneIndex += 1) {
            await splitActiveWorkspaceDocument(session, 'right');
            await openSourceInActivePane(session, sourceFixture.path, paneIndex + 1);
        }

        let paneStates = await waitForNativePanesReady(session, SOURCE_PANE_COUNT);
        expect(new Set(paneStates.map(state => state.imageSource)).size).toBe(SOURCE_PANE_COUNT);
        expect(paneStates.every(state => state.shellCount === 1), JSON.stringify(paneStates)).toBe(true);

        for (const pane of paneStates) {
            await activatePane(session, pane.paneId);
            await setActiveNativeZoom(session, pane.paneId);
        }
        paneStates = await waitForNativePanesReady(session, SOURCE_PANE_COUNT);
        expect(paneStates.every(state => state.imageWidth >= 3_000), JSON.stringify(paneStates)).toBe(true);

        const mutationTarget = paneStates.find(state => state.active);
        expect(mutationTarget).toBeTruthy();
        const targetWorkingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
        let rotation;
        try {
            rotation = await rotatePages(session.page, targetWorkingCopyPath, [1], 1, 90);
        } catch (error) {
            const serializedFailure = getDocumentMutationErrorPayload(error);
            expect(serializedFailure).toMatchObject({
                code: 'STALE_REVISION',
                documentRef: targetWorkingCopyPath,
            });
            expect(serializedFailure?.actualRevision).not.toBe(serializedFailure?.expectedRevision);
            rotation = await rotatePages(session.page, targetWorkingCopyPath, [1], 1, 90);
        }
        expect(rotation).toMatchObject({success: true});
        await session.page.waitForFunction((target: {
            imageHeight: number;
            imageSource: string;
            imageWidth: number;
            paneId: string;
        }) => {
            const state = (window as TNativeLifecycleWindow)
                .__readNativeSplitLifecyclePanes?.()
                .find(candidate => candidate.paneId === target.paneId);
            return Boolean(
                state
                && state.committed
                && state.errorTexts.length === 0
                && state.imageReady
                && state.imageSource !== target.imageSource
                && state.imageWidth > state.imageHeight
                && Math.abs(
                    state.imageWidth / state.imageHeight
                    - target.imageHeight / target.imageWidth,
                ) < 0.02
                && state.phase === 'ready'
                && state.viewportLifecycle === 'ready',
            );
        }, {timeout: MUTATION_SETTLE_TIMEOUT_MS}, mutationTarget!);
        const afterRevision = await waitForNativePanesReady(session, SOURCE_PANE_COUNT);
        for (const beforePane of paneStates.filter(state => state.paneId !== mutationTarget!.paneId)) {
            const afterPane = afterRevision.find(state => state.paneId === beforePane.paneId);
            expect(afterPane?.imageSource).toBe(beforePane.imageSource);
            expect(afterPane?.imageHeight).toBe(beforePane.imageHeight);
            expect(afterPane?.imageWidth).toBe(beforePane.imageWidth);
        }

        const eviction = await exerciseCurrentPageEviction(session);
        const evictionDetail = JSON.stringify(eviction);
        expect(eviction.beforeBudget.reservedBytesByCategory['native-preview'], evictionDetail).toBeGreaterThan(0);
        expect(eviction.observedEviction, evictionDetail).toBe(true);
        expect(eviction.frames.length, evictionDetail).toBeGreaterThan(0);
        expect(eviction.frames.every(frame => frame.panes.every(pane => (
            pane.imageReady || pane.skeletonVisible
        ))), evictionDetail).toBe(true);
        expect(eviction.pressureBudget.reservedBytes, evictionDetail)
            .toBeLessThan(eviction.beforeBudget.reservedBytes);
        expect(eviction.pressureBudget.reservedBytesByCategory['native-preview'], evictionDetail)
            .toBeLessThan(eviction.beforeBudget.reservedBytesByCategory['native-preview'] ?? 0);
        await waitForNativePanesReady(session, SOURCE_PANE_COUNT);

        const pendingOpenTarget = (await readNativePaneStates(session)).find(state => state.active);
        expect(pendingOpenTarget).toBeTruthy();
        await triggerOpenPathInApp(session.page, successorFixture.path, LIFECYCLE_TIMEOUT_MS);
        const pendingOpenOwner = await waitForPendingOpenOwner(session, pendingOpenTarget!.paneId);
        const survivingPaneCount = await closeClaimedOpenTab(session, pendingOpenOwner);
        const survivingStates = await waitForNativePanesReady(session, survivingPaneCount);
        expect(survivingStates.every(state => state.shellCount === 1), JSON.stringify(survivingStates)).toBe(true);
        expect(survivingStates.every(state => state.errorTexts.length === 0), JSON.stringify(survivingStates)).toBe(true);

        if (survivingPaneCount < SOURCE_PANE_COUNT) {
            await splitActiveWorkspaceDocument(session, 'right');
        }
        await openNativePdfPreviewInApp(session.page, successorFixture.path, LIFECYCLE_TIMEOUT_MS);
        const finalStates = await waitForNativePanesReady(session, SOURCE_PANE_COUNT);
        const finalActive = finalStates.find(state => state.active);
        const finalToolbar = await getWorkspaceToolbarSnapshot(session.page);
        expect(finalToolbar?.totalPages).toBe(3);
        expect(finalActive?.shellCount).toBeGreaterThan(0);
        expect(finalActive?.committed).toBe(true);
        expect(finalActive?.errorTexts).toEqual([]);
        expect(finalStates.filter(state => !state.active).every(state => (
            state.shellCount === 1 && state.committed && state.errorTexts.length === 0
        )), JSON.stringify(finalStates)).toBe(true);
    }, LIFECYCLE_TIMEOUT_MS);
});
