import {
    describe,
    expect,
    it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {createLargeScannedFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    clickVisibleToolbarButton,
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';

const sessionFixture = createElectronE2ESessionFixture({
    sessionName: () => `e2e-scan-cleanup-toolbar-contract-${Date.now()}`,
    windowMode: 'hidden',
});

// The packaged release verifier (scripts/release/verifyPackagedScanCleanup.ts)
// drives this exact toolbar contract over CDP, but it only executes at
// release time, so UI drift against it surfaces days later inside a release
// campaign (issue #82's tail: the #68/#70 toolbar redesign silently broke the
// counter copy and the meter's attribute shape, killing three release
// attempts). This blocking test pins the same contract against the dev app on
// every relevant change: a parseable completed/total detection counter, a
// cancellable in-flight detection, cleanup queueable while detection runs,
// and a run meter that reports the queued pre-analysis state as text.
describe('scan cleanup toolbar contract', () => {
    it('keeps the detection counter, queued cleanup, and run meter contract the release verifier relies on', async () => {
        const session = sessionFixture.getSession();
        expect(session).toBeTruthy();
        if (!session) {
            return;
        }

        // Enough pages that detection is reliably observable in flight.
        const sourcePath = await createLargeScannedFixturePdf(
            'scan-cleanup-toolbar-contract.pdf',
            6,
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

        // Detection in flight: counter exposes a completed/total pair, the
        // detection is cancellable, and the primary action stays enabled so
        // cleanup can be queued behind detection. The wait itself is the
        // assertion; it throws after 90s if the contract never holds.
        await waitForFunctionInPage(session.page, (expectedTotal: number) => {
            const action = document.querySelector<HTMLButtonElement>(
                '.scan-cleanup-toolbar-primary-action',
            );
            const status = document.querySelector<HTMLElement>('.scan-cleanup-toolbar-count');
            const text = status?.getAttribute('aria-label') ?? status?.textContent ?? '';
            const match = /(\d+)\D+(\d+)/u.exec(text);
            return action?.disabled === false
                && document.querySelector('.scan-cleanup-toolbar-cancel-detection') !== null
                && match !== null
                && Number(match[2]) === expectedTotal
                && Number(match[1]) < expectedTotal;
        }, {timeout: 90_000}, 6);

        // Queue cleanup while detection is still running: the run meter must
        // appear and report the queued pre-analysis state as readable text,
        // and the primary action must remain enabled (it becomes cancel).
        await session.page.click('.scan-cleanup-toolbar-primary-action');
        await waitForFunctionInPage(session.page, () => {
            const meter = document.querySelector<HTMLElement>('.scan-cleanup-run-meter');
            const action = document.querySelector<HTMLButtonElement>(
                '.scan-cleanup-toolbar-primary-action',
            );
            return meter !== null
                && (meter.textContent ?? '').trim().length > 0
                && action?.disabled === false;
        }, {timeout: 10_000});
        const queuedStatusText = await session.page.evaluate(() =>
            document.querySelector<HTMLElement>('.scan-cleanup-run-meter')
                ?.textContent?.trim() ?? '');
        expect(queuedStatusText.toLowerCase()).toContain('pre-analyzing');

        // Cancel the queued run: the meter clears while detection continues.
        await session.page.click('.scan-cleanup-toolbar-primary-action');
        await waitForFunctionInPage(session.page, () => (
            document.querySelector('.scan-cleanup-run-meter') === null
            && document.querySelector('.scan-cleanup-toolbar-cancel-detection') !== null
        ), {timeout: 10_000});
    });
});
