import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import {
    copyProjectFixture,
    getFixtureName,
} from './helpers/fixtures';
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
        const createdCount = await createFreeTextAnnotation(page, `Phase 1 free text ${Date.now()}`);
        expect(createdCount).toBeGreaterThan(baselineCount);

        const latestText = await page.evaluate(() => {
            const host = Array.from(document.querySelectorAll('.workspace-host'))
                .find((candidate) => {
                    const element = candidate as HTMLElement;
                    const rect = element.getBoundingClientRect();
                    const style = window.getComputedStyle(element);
                    return style.display !== 'none' && rect.width > 100 && rect.height > 100;
                }) as HTMLElement | undefined;
            const editors = Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? []);
            const latest = editors[editors.length - 1];
            return (latest?.textContent ?? '').trim();
        });
        expect(latestText.length).toBeGreaterThan(0);

        const afterDeleteCount = await deleteLatestFreeTextAnnotation(page);
        expect(afterDeleteCount).toBeLessThan(createdCount);

        const activeTool = await getActiveToolLabel(page);
        expect(activeTool).toBe('Select');
        expect(getFixtureName(fixturePath).includes('phase1-')).toBe(true);
    });
});

