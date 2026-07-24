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

        const outputState = await readWorkspaceStateValues(session.page, ['originalPath']);
        const outputPath = typeof outputState.originalPath === 'string'
            ? outputState.originalPath
            : null;
        expect(outputPath).toBeTruthy();
        expect(outputPath).not.toBe(sourcePath);
        expect(outputPath).toMatch(/— cleaned\.pdf$/u);
        expect(existsSync(outputPath!)).toBe(true);
        expect(statSync(outputPath!).size).toBeGreaterThan(0);
        expect(await readPdfPageSnapshots(outputPath!)).toEqual([{
            pageNumber: 1,
            rotation: 0,
            textSnippet: '',
        }]);
    }, 360_000);
});
