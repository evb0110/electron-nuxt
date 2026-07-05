import {
    describe,
    it,
} from 'vitest';
import { createMultiPageTextFixturePdf } from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    clickVisibleToolbarButton,
    openPdfInApp,
    waitForPdfLoaded,
    waitForToolbarCurrentPage,
} from '@tests/e2e/electron/helpers/viewerCore';
import { waitForWorkspaceToolbarSnapshot } from '@tests/e2e/electron/helpers/workspaceExpose';

const PR_BLOCKING_SMOKE_TIMEOUT_MS = 90_000;

describe('Electron E2E - PR Blocking Smoke', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: 'e2e-pr-blocking-smoke',
        timeoutMs: PR_BLOCKING_SMOKE_TIMEOUT_MS,
    });

    it('boots Electron, opens a generated PDF, and navigates the viewer', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        const fixturePath = await createMultiPageTextFixturePdf('pr-blocking-smoke.pdf', 3);
        await openPdfInApp(session.page, fixturePath, PR_BLOCKING_SMOKE_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, PR_BLOCKING_SMOKE_TIMEOUT_MS);
        await waitForWorkspaceToolbarSnapshot(
            session.page,
            {
                hasPdf: true,
                currentPage: 1,
                minTotalPages: 3,
            },
            {timeoutMs: PR_BLOCKING_SMOKE_TIMEOUT_MS},
        );

        await clickVisibleToolbarButton(session.page, 'Next Page');
        await waitForToolbarCurrentPage(session.page, 2);

        await waitForWorkspaceToolbarSnapshot(
            session.page,
            {
                hasPdf: true,
                currentPage: 2,
                minTotalPages: 3,
            },
            {timeoutMs: PR_BLOCKING_SMOKE_TIMEOUT_MS},
        );
    });
});
