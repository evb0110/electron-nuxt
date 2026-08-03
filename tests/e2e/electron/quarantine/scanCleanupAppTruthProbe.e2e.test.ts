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
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    clickVisibleToolbarButton,
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import type {IWorkspaceExposeProbeWindow} from '@tests/e2e/electron/helpers/workspaceExpose';

const SOURCE_PATH = process.env.EVB_APP_TRUTH_SOURCE_PDF ?? '';
const PAGE_COUNT = Number(process.env.EVB_APP_TRUTH_PAGE_COUNT ?? '0');

const sessionFixture = createElectronE2ESessionFixture({
    sessionName: () => `e2e-scan-cleanup-app-truth-${Date.now()}`,
    windowMode: 'hidden',
});

describe('scan cleanup app-truth probe', () => {
    // A diagnostic harness, not a regression test: it drives the product
    // pipeline over an operator-supplied PDF to compare app-context output
    // against fixture runs. Without a source it has nothing to measure.
    it.skipIf(SOURCE_PATH === '' || PAGE_COUNT <= 0)(
        'cleans the probe source through the product pipeline',
        async () => {
            const session = sessionFixture.getSession();
            expect(session).toBeTruthy();
            if (!session) {
                return;
            }
            expect(SOURCE_PATH).toBeTruthy();
            expect(PAGE_COUNT).toBeGreaterThan(0);
            expect(existsSync(SOURCE_PATH)).toBe(true);

            await openPdfInApp(session.page, SOURCE_PATH, 120_000);
            await waitForPdfLoaded(session.page, 120_000);
            await waitForViewerInteractive(session.page, 120_000);
            await waitForFunctionInPage(session.page, () => {
                const api = (window as IWorkspaceExposeProbeWindow).__evbTestApi;
                const toolbar = api?.getActiveToolbarSnapshot?.();
                return toolbar?.initialVisualReady === true
                && toolbar.viewerCapabilities.pdfMutationActions === true
                && toolbar.isOpeningDocument === false
                && toolbar.totalPages > 0;
            }, {
                timeout: 600_000,
                polling: 5_000,
            });

            await clickVisibleToolbarButton(session.page, 'Scan cleanup');
            await session.page.waitForSelector('.scan-cleanup-surface', {
                timeout: 10_000,
                visible: true,
            });
            // Wait for detection to classify every page so the run consumes the
            // same fully-populated plan a patient user-triggered run does. The
            // rail virtualizes its thumbnails, so this only converges for probe
            // subsets small enough that every page's overlay is mounted.
            await waitForFunctionInPage(session.page, (expectedPages: number) => {
                const classified = document.querySelectorAll(
                    '.scan-thumbnail-overlay[data-classification]',
                ).length;
                const action = document.querySelector<HTMLButtonElement>(
                    '.scan-cleanup-toolbar-primary-action',
                );
                return classified >= expectedPages && Boolean(action) && !action!.disabled;
            }, {
                timeout: 1_800_000,
                polling: 2_000,
            }, PAGE_COUNT);

            await session.page.click('.scan-cleanup-toolbar-primary-action');
            await waitForFunctionInPage(session.page, (source: string) => {
                const active = (window as IWorkspaceExposeProbeWindow)
                    .__evbTestApi
                    ?.readActiveWorkspaceStateValues?.(['originalPath']);
                return typeof active?.originalPath === 'string'
                && active.originalPath !== source
                && active.originalPath.endsWith('— cleaned.pdf');
            }, {
                timeout: 2_400_000,
                polling: 2_000,
            }, SOURCE_PATH);

            const outputPath = await session.page.evaluate(() => (
                (window as IWorkspaceExposeProbeWindow)
                    .__evbTestApi
                    ?.readActiveWorkspaceStateValues?.(['originalPath'])?.originalPath
            )) as string;
            // The pipeline publishes into the app-managed temp output root; the
            // workspace path is the human-facing name of that generated file.
            console.log(`[app-truth-probe] cleaned output: ${outputPath}`);
            expect(outputPath.endsWith('— cleaned.pdf')).toBe(true);
            expect(existsSync(outputPath)).toBe(true);
            expect(statSync(outputPath).size).toBeGreaterThan(0);
        },
        4_500_000,
    );
});
