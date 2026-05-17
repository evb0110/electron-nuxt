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
} from './helpers/sessionHarness';
import {
    createFreeTextAnnotation,
    getFreeTextEditorCount,
    openAnnotationsTab,
    openPdfInApp,
    waitForActiveWorkspaceHost,
    waitForPdfLoaded,
} from './helpers/viewerHelpers';

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

    it('creates and edits a FreeText annotation in the active workspace', async () => {
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
        const latestTextHandle = await page.waitForFunction((expectedText: string) => {
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
            const matchingText = editors
                .map((editor) => (editor.querySelector<HTMLElement>('[contenteditable], .internal') ?? editor).textContent ?? '')
                .map(text => text.replace(/\u200B/g, '').trim())
                .find(text => text.includes(expectedText));
            return matchingText ?? false;
        }, { timeout: 8_000 }, typedText);
        const latestText = await latestTextHandle.jsonValue();
        expect(latestText).toContain(typedText);
    });
});
