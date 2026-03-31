import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import {copyProjectFixture} from './helpers/fixtures';
import {
    type IElectronE2ESession,
    startElectronE2ESession,
} from './helpers/session-harness';
import {
    createFreeTextAnnotation,
    deleteLatestFreeTextAnnotation,
    getActiveToolLabel,
    getFreeTextEditorCount,
    openAnnotationsTab,
    openPdfInApp,
    waitForActiveWorkspaceHost,
    waitForPdfLoaded,
} from './helpers/viewer-helpers';

describe('Electron E2E - Phase 1 (Annotation Lifecycle)', () => {
    let session: IElectronE2ESession | null = null;
    let fixturePath = '';

    beforeAll(async () => {
        session = await startElectronE2ESession(`e2e-phase1-${Date.now()}`);
        fixturePath = copyProjectFixture('freetext-lifecycle-test.pdf', `phase1-${Date.now()}-freetext.pdf`);
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);
    });

    afterAll(async () => {
        await session?.stop();
    });

    it('creates, edits, and deletes a FreeText annotation in the active workspace', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 session was not initialized');
        }

        await openAnnotationsTab(page);

        const baselineCount = await getFreeTextEditorCount(page);
        const typedText = `Phase 1 free text ${Date.now()}`;
        const createdCount = await createFreeTextAnnotation(page, typedText);
        expect(createdCount).toBeGreaterThan(baselineCount);

        await waitForActiveWorkspaceHost(page);
        const latestText = await page.evaluate(() => {
            const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
            const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .filter((candidate) => {
                    const rect = candidate.getBoundingClientRect();
                    const style = window.getComputedStyle(candidate);
                    return (
                        style.display !== 'none'
                        && style.visibility !== 'hidden'
                        && Number(style.opacity || '1') > 0
                        && rect.width > 100
                        && rect.height > 100
                    );
                });
            const host = (activeHost && visibleHosts.includes(activeHost))
                ? activeHost
                : (visibleHosts.length === 1 ? visibleHosts[0] : null);
            const editors = Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? []);
            const latest = editors[editors.length - 1];
            return (latest?.textContent ?? '').trim();
        });
        expect(latestText).toContain(typedText);

        const afterDeleteCount = await deleteLatestFreeTextAnnotation(page);
        expect(afterDeleteCount).toBe(baselineCount);

        const activeTool = await getActiveToolLabel(page);
        expect(activeTool).toSatisfy(
            (v: string | null) => v === null || v === 'none',
        );
    });
});
