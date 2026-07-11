import {
    describe,
    expect,
    it,
} from 'vitest';
import {readFile} from 'node:fs/promises';
import {PDFDocument} from 'pdf-lib';
import { createMultiPageTextFixturePdf } from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    getActiveWorkspaceWorkingCopyPath,
    rotatePages,
} from '@tests/e2e/electron/helpers/electronApiHelpers';
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

    it('opens a PDF, persists a real IPC rotation, and navigates the viewer', async () => {
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

        const workingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
        await expect(rotatePages(session.page, workingCopyPath, [1], 3, 90)).resolves.toMatchObject({success: true});
        const rotatedPdf = await PDFDocument.load(await readFile(workingCopyPath), {updateMetadata: false});
        expect(rotatedPdf.getPage(0).getRotation().angle).toBe(90);

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
