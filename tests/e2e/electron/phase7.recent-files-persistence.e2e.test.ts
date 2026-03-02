import type { Page } from 'puppeteer-core';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { copyProjectFixture } from './helpers/fixtures';
import { startElectronE2ESession } from './helpers/session-harness';
import {
    openPdfInApp,
    waitForPdfLoaded,
} from './helpers/viewer-helpers';

async function readRecentFilePaths(session: {page: Page;}) {
    return session.page.evaluate(async () => {
        const api = (window as Window & {electronAPI?: {documents?: {recentFiles?: {get?: () => Promise<Array<{originalPath: string;}>>;};};};}).electronAPI;

        const getter = api?.documents?.recentFiles?.get;
        if (!getter) {
            throw new Error('electronAPI.documents.recentFiles.get is unavailable');
        }

        const entries = await getter();
        return entries.map(entry => entry.originalPath);
    });
}

describe('Electron E2E - Phase 7 (Recent Files Persistence)', () => {
    it('keeps recent file entries after app restart in same session data', async () => {
        const sessionName = `e2e-phase7-restore-${Date.now()}`;
        const fixtureOne = copyProjectFixture('generated-text.pdf', `phase7-a-${Date.now()}.pdf`);
        const fixtureTwo = copyProjectFixture('freetext-lifecycle-test.pdf', `phase7-b-${Date.now()}.pdf`);

        const firstSession = await startElectronE2ESession(sessionName, { clean: true });
        try {
            await openPdfInApp(firstSession.page, fixtureOne);
            await waitForPdfLoaded(firstSession.page);

            await openPdfInApp(firstSession.page, fixtureTwo);
            await waitForPdfLoaded(firstSession.page);

            const recentBefore = await readRecentFilePaths(firstSession);
            expect(recentBefore).toContain(fixtureOne);
            expect(recentBefore).toContain(fixtureTwo);
        } finally {
            await firstSession.stop();
        }

        const restoredSession = await startElectronE2ESession(sessionName, { clean: false });
        try {
            const recentAfter = await readRecentFilePaths(restoredSession);
            expect(recentAfter).toContain(fixtureOne);
            expect(recentAfter).toContain(fixtureTwo);
        } finally {
            await restoredSession.stop();
        }
    });
});
