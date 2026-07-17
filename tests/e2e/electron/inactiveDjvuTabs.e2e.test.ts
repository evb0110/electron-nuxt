import {
    describe,
    expect,
    it,
} from 'vitest';
import { copyFileSync } from 'node:fs';
import {
    createFixturePath,
    createMultiPageTextFixturePdf,
    resolveDjvuFixturePath,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/getE2EWindow';
import {assertInactiveDocumentPressureReleased} from '@tests/e2e/electron/helpers/viewerPressure';
import {
    goToPageViaToolbar,
    openDjvuInApp,
    openPdfInApp,
    setTabMemoryPolicyForE2E,
    waitForDjvuLoaded,
    waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {waitForTabCount} from '@tests/e2e/electron/helpers/viewerTabs';
import {
    callWorkspaceCommand,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    expectSplitPaneCloseContinuity,
    runSplitPaneCloseContinuity,
} from '@tests/e2e/electron/helpers/splitPaneCloseContinuity';

interface IWorkspaceDjvuPressure {
    index: number;
    active: boolean;
    visible: boolean;
    pageShells: number;
    images: number;
}

interface IDjvuActivationOccupancyFrame {
    canonicalShellCount: number;
    elapsedMs: number;
    effectiveZoom: number | null;
    shellVisuals: string[];
    visibleShellCount: number;
}

interface IDjvuActivationOccupancyProbe {
    frames: IDjvuActivationOccupancyFrame[];
    startedAt: number;
    animationFrame: number;
}

interface IDjvuActivationOccupancyWindow extends Window {__djvuActivationOccupancyProbe?: IDjvuActivationOccupancyProbe;}

const DJVU_E2E_TIMEOUT_MS = 90_000;

function readDjvuPressureFromPage(): IWorkspaceDjvuPressure[] {
    const isVisible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
            style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number(style.opacity || '1') > 0
            && rect.width > 100
            && rect.height > 100
        );
    };

    return Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
        .map((host, index) => {
            const visible = isVisible(host);
            return {
                index,
                active: visible,
                visible,
                pageShells: host.querySelectorAll('[data-testid="document-page-source-page"]').length,
                images: host.querySelectorAll('[data-testid="document-page-source-image"]').length,
            };
        });
}

async function createNewTab(session: IElectronE2ESession) {
    const nextCount = await session.page.$$eval('.tab-list .tab[data-tab-id]', tabs => tabs.length + 1);
    const clicked = await session.page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>('.tab-list .tab-new');
        button?.click();
        return Boolean(button);
    });
    expect(clicked).toBe(true);
    await waitForTabCount(session.page, nextCount);
}

async function activateTab(session: IElectronE2ESession, tabIndex: number) {
    await session.page.evaluate((index: number) => {
        const tabs = Array.from(document.querySelectorAll<HTMLElement>('.tab-list .tab[data-tab-id]'));
        tabs[index]?.click();
    }, tabIndex);
}

async function installDjvuActivationOccupancyProbe(session: IElectronE2ESession) {
    await session.page.evaluate(() => {
        const probeWindow = window as IDjvuActivationOccupancyWindow;
        if (probeWindow.__djvuActivationOccupancyProbe) {
            cancelAnimationFrame(probeWindow.__djvuActivationOccupancyProbe.animationFrame);
        }
        const probe: IDjvuActivationOccupancyProbe = {
            animationFrame: 0,
            frames: [],
            startedAt: performance.now(),
        };
        const isVisible = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 100
                && rect.height > 100;
        };
        const sample = () => {
            const host = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .find(candidate => (
                    isVisible(candidate)
                    && candidate.querySelector('[data-testid="document-page-source-viewer"]')
                ));
            const viewport = host?.querySelector<HTMLElement>('[data-document-viewer-chassis-viewport]') ?? null;
            if (viewport) {
                const viewportRect = viewport.getBoundingClientRect();
                const visibleShells = Array.from(viewport.querySelectorAll<HTMLElement>(
                    '[data-testid="document-page-source-page"]',
                )).filter((shell) => {
                    const rect = shell.getBoundingClientRect();
                    return rect.bottom > viewportRect.top + 1
                        && rect.top < viewportRect.bottom - 1
                        && rect.right > viewportRect.left + 1
                        && rect.left < viewportRect.right - 1;
                });
                const canonicalShellCount = visibleShells.filter((shell) => {
                    const skeleton = shell.querySelector<HTMLElement>('.document-page-skeleton');
                    if (skeleton && getComputedStyle(skeleton).display !== 'none') {
                        return true;
                    }
                    const image = shell.querySelector<HTMLImageElement>(
                        ':scope > [data-testid="document-page-source-image"]',
                    );
                    return Boolean(
                        image?.complete
                        && image.naturalWidth > 0
                        && image.naturalHeight > 0
                        && getComputedStyle(image).visibility === 'visible',
                    );
                }).length;
                probe.frames.push({
                    canonicalShellCount,
                    elapsedMs: performance.now() - probe.startedAt,
                    effectiveZoom: (window as IE2EWindow)
                        .__evbTestApi?.getActiveToolbarSnapshot?.()?.effectiveZoom ?? null,
                    shellVisuals: visibleShells.map(shell => shell.dataset.pageSourceVisual ?? ''),
                    visibleShellCount: visibleShells.length,
                });
            }
            probe.animationFrame = requestAnimationFrame(sample);
        };
        probeWindow.__djvuActivationOccupancyProbe = probe;
        probe.animationFrame = requestAnimationFrame(sample);
    });
}

async function stopDjvuActivationOccupancyProbe(session: IElectronE2ESession) {
    return session.page.evaluate(() => {
        const probeWindow = window as IDjvuActivationOccupancyWindow;
        const probe = probeWindow.__djvuActivationOccupancyProbe;
        if (!probe) {
            return [] as IDjvuActivationOccupancyFrame[];
        }
        cancelAnimationFrame(probe.animationFrame);
        delete probeWindow.__djvuActivationOccupancyProbe;
        return probe.frames;
    });
}

async function splitActiveDocument(session: IElectronE2ESession, direction: 'right' | 'down' = 'right') {
    const split = await session.page.evaluate(async (targetDirection: 'right' | 'down') => {
        const splitEditor = (window as IE2EWindow & {__splitEditorForE2E?: (direction: 'right' | 'down') => Promise<void> | void;}).__splitEditorForE2E;
        if (typeof splitEditor === 'function') {
            await splitEditor(targetDirection);
            return true;
        }
        return false;
    }, direction);

    expect(split).toBe(true);
    await session.page.waitForFunction(() => document.querySelectorAll('.editor-pane').length >= 2);
}

async function waitForActiveDjvuImages(session: IElectronE2ESession) {
    await session.page.waitForFunction(() => {
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        return (activeHost?.querySelectorAll('[data-testid="document-page-source-image"]').length ?? 0) > 0;
    }, { timeout: 20_000 });
}

async function waitForActiveDjvuCommittedPage(session: IElectronE2ESession, pageNumber: number) {
    await session.page.waitForFunction((expectedPage: number) => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const viewport = host?.querySelector<HTMLElement>('[data-document-viewer-chassis-viewport]');
        const page = viewport?.querySelector<HTMLElement>(
            `[data-testid="document-page-source-page"][data-page-number="${String(expectedPage)}"]`,
        );
        const image = page?.querySelector<HTMLImageElement>(
            ':scope > [data-testid="document-page-source-image"]',
        );
        const style = image ? window.getComputedStyle(image) : null;
        return Boolean(
            page?.dataset.pageSourceVisual === 'fresh'
            && !page.querySelector('.document-source-viewer__skeleton')
            && image?.complete
            && image.naturalWidth > 0
            && image.naturalHeight > 0
            && image.classList.contains('document-page-visual--committed')
            && image.dataset.documentPageVisual === 'committed'
            && style?.visibility === 'visible',
        );
    }, {timeout: DJVU_E2E_TIMEOUT_MS}, pageNumber);
}

async function waitForVisibleDjvuImageHosts(session: IElectronE2ESession, expectedCount: number) {
    await session.page.waitForFunction((expected: number) => {
        const isVisible = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 100
                && rect.height > 100
            );
        };

        return Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(host => isVisible(host) && host.querySelectorAll('[data-testid="document-page-source-image"]').length > 0)
            .length >= expected;
    }, { timeout: DJVU_E2E_TIMEOUT_MS }, expectedCount);
}

async function waitForInactiveDjvuImagesToRelease(session: IElectronE2ESession) {
    await session.page.waitForFunction(() => {
        const isVisible = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 100
                && rect.height > 100
            );
        };
        return Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(host => !isVisible(host))
            .every(host => host.querySelectorAll('[data-testid="document-page-source-image"]').length === 0);
    }, { timeout: 20_000 });
}

const djvuFixture = resolveDjvuFixturePath();
const runOrSkip = selectFixtureDescribe(describe, djvuFixture);

runOrSkip('Electron E2E - Inactive DjVu Tabs', () => {
    let pdfFixturePath = '';

    const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-inactive-djvu-tabs-${Date.now()}`});

    it('releases hidden DjVu page images and restores previews on activation', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        await setTabMemoryPolicyForE2E(session.page, 'aggressive', DJVU_E2E_TIMEOUT_MS);
        pdfFixturePath = await createMultiPageTextFixturePdf(`inactive-djvu-other-tab-${Date.now()}.pdf`, 3);
        await openDjvuInApp(session.page, djvuFixture.path, DJVU_E2E_TIMEOUT_MS);
        await waitForDjvuLoaded(session.page, DJVU_E2E_TIMEOUT_MS);
        await waitForActiveDjvuImages(session);
        await goToPageViaToolbar(session.page, 18);
        await waitForActiveDjvuCommittedPage(session, 18);
        expect((await callWorkspaceCommand(
            session.page,
            'setCustomZoomFromDisplay',
            [4.3],
        )).called).toBe(true);
        await waitForWorkspaceToolbarSnapshot(
            session.page,
            {minEffectiveZoom: 4.295},
            {timeoutMs: DJVU_E2E_TIMEOUT_MS},
        );
        await waitForActiveDjvuCommittedPage(session, 18);

        const afterDjvuOpen = await session.page.evaluate(readDjvuPressureFromPage);
        expect(afterDjvuOpen).toHaveLength(1);
        expect(afterDjvuOpen[0]?.active).toBe(true);
        expect(afterDjvuOpen[0]?.images).toBeGreaterThan(0);

        await createNewTab(session);
        await openPdfInApp(session.page, pdfFixturePath);
        await waitForPdfLoaded(session.page);
        await waitForInactiveDjvuImagesToRelease(session);

        const afterPdfOpen = await session.page.evaluate(readDjvuPressureFromPage);
        expect(afterPdfOpen.length).toBeGreaterThanOrEqual(1);
        expect(afterPdfOpen.length).toBeLessThanOrEqual(2);
        expect(afterPdfOpen.filter(host => !host.active).every(host => host.images === 0)).toBe(true);

        await installDjvuActivationOccupancyProbe(session);
        await activateTab(session, 0);
        await waitForDjvuLoaded(session.page);
        await waitForActiveDjvuImages(session);
        await waitForActiveDjvuCommittedPage(session, 18);
        const restoredSnapshot = await waitForWorkspaceToolbarSnapshot(
            session.page,
            {
                currentPage: 18,
                minEffectiveZoom: 4.295,
            },
            {timeoutMs: DJVU_E2E_TIMEOUT_MS},
        );
        expect(restoredSnapshot.zoomMode).toBe('custom');
        expect(restoredSnapshot.zoom).toBeCloseTo(4.3, 3);
        expect(restoredSnapshot.effectiveZoom).toBeCloseTo(4.3, 3);
        const activationFrames = await stopDjvuActivationOccupancyProbe(session);
        expect(activationFrames.length, JSON.stringify(activationFrames)).toBeGreaterThan(5);
        expect(
            activationFrames.every(frame => (
                frame.visibleShellCount > 0
                && frame.canonicalShellCount > 0
            )),
            JSON.stringify(activationFrames),
        ).toBe(true);

        const afterDjvuReactivation = await session.page.evaluate(readDjvuPressureFromPage);
        const activeAfterDjvuReactivation = afterDjvuReactivation.find(host => host.active);
        expect(activeAfterDjvuReactivation?.images).toBeGreaterThan(0);
        expect(afterDjvuReactivation.filter(host => !host.active).every(host => host.images === 0)).toBe(true);
    }, 120_000);

    it('keeps independently opened visible split-pane DjVu documents rendered', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        await activateTab(session, 0);
        await waitForDjvuLoaded(session.page, DJVU_E2E_TIMEOUT_MS);
        await waitForActiveDjvuImages(session);

        const independentDjvuPath = createFixturePath(`split-pane-${Date.now()}.djvu`);
        copyFileSync(djvuFixture.path, independentDjvuPath);
        await splitActiveDocument(session, 'right');
        await openDjvuInApp(session.page, independentDjvuPath, DJVU_E2E_TIMEOUT_MS);
        await waitForDjvuLoaded(session.page, DJVU_E2E_TIMEOUT_MS);
        await waitForVisibleDjvuImageHosts(session, 2);

        const pressure = await assertInactiveDocumentPressureReleased(session.page);
        expect(pressure.filter(host => host.active).length).toBeGreaterThanOrEqual(2);
        expect(pressure.filter(host => host.active).every(host => host.djvuImages > 0)).toBe(true);
    });

    it('keeps the exact DjVu pane, tab, document surface, and viewport anchor while closing an empty split', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-djvu-empty-split-continuity-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        await openDjvuInApp(session.page, djvuFixture.path, DJVU_E2E_TIMEOUT_MS);
        await waitForDjvuLoaded(session.page, DJVU_E2E_TIMEOUT_MS);
        await waitForActiveDjvuImages(session);

        await goToPageViaToolbar(session.page, 18);
        await waitForActiveDjvuImages(session);

        const continuity = await runSplitPaneCloseContinuity(session, {
            documentKind: 'djvu',
            expectedPageNumber: 18,
        });
        expectSplitPaneCloseContinuity(continuity);
    }, 120_000);
});
