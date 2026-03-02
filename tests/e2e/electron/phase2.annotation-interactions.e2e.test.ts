import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import {
    copyProjectFixture,
    createLinkOverlayFixturePdf,
    createMultiPageTextFixturePdf,
} from './helpers/fixtures';
import {
    type IElectronE2ESession,
    startElectronE2ESession,
} from './helpers/session-harness';
import {
    clickAnnotationTool,
    clickFirstLinkOverlay,
    countFreeTextEditorsOnPage,
    createFreeTextAnnotation,
    createHighlightFromVisibleText,
    getFirstFreeTextComputedColor,
    getHighlightEditorCount,
    getLinkOverlayCount,
    installOpenExternalSpy,
    openAnnotationsTab,
    openContextMenuOnLatestFreeText,
    openPdfInApp,
    readOpenExternalCalls,
    scrollViewerToPage,
    setAnnotationColor,
    waitForPdfLoaded,
} from './helpers/viewer-helpers';

describe('Electron E2E - Phase 2 (Interactions + Links + Multi-Page)', () => {
    let session: IElectronE2ESession | null = null;

    beforeAll(async () => {
        session = await startElectronE2ESession(`e2e-phase2-${Date.now()}`);
    });

    afterAll(async () => {
        await session?.stop();
    });

    it('applies style controls and creates a highlight from visible text', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 2 session was not initialized');
        }

        const styleFixture = copyProjectFixture('generated-text.pdf', `phase2-style-${Date.now()}.pdf`);
        await openPdfInApp(page, styleFixture);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);

        await clickAnnotationTool(page, 'Text');
        await setAnnotationColor(page, '#ef4444');
        await createFreeTextAnnotation(page, `phase2-style-${Date.now()}`);

        const textColor = await getFirstFreeTextComputedColor(page);
        expect(textColor).toBeTruthy();

        const beforeHighlights = await getHighlightEditorCount(page);
        const afterHighlights = await createHighlightFromVisibleText(page);
        expect(afterHighlights).toBeGreaterThan(beforeHighlights);

        const contextMenu = await openContextMenuOnLatestFreeText(page);
        expect(contextMenu.visible).toBe(true);
        expect(contextMenu.items.some(item => item.toLowerCase().includes('delete'))).toBe(true);
    });

    it('opens external link overlays through electron shell bridge', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 2 session was not initialized');
        }

        const linkFixture = await createLinkOverlayFixturePdf(
            `phase2-links-${Date.now()}.pdf`,
            'https://openai.com',
        );
        await openPdfInApp(page, linkFixture);
        await waitForPdfLoaded(page);

        const spyInstalled = await installOpenExternalSpy(page);
        expect(spyInstalled).toBe(true);

        const linkOverlayCount = await getLinkOverlayCount(page);
        expect(linkOverlayCount).toBeGreaterThan(0);

        await clickFirstLinkOverlay(page);
        const openedUrls = await readOpenExternalCalls(page);
        expect(openedUrls.some(url => url.includes('openai.com'))).toBe(true);
    });

    it('creates independent annotations on different pages', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 2 session was not initialized');
        }

        const multiPageFixture = await createMultiPageTextFixturePdf(`phase2-multipage-${Date.now()}.pdf`, 3);
        await openPdfInApp(page, multiPageFixture);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);

        await createFreeTextAnnotation(page, 'page-one-note', {
            x: 0.42,
            y: 0.28,
        }, 1);

        await scrollViewerToPage(page, 3);
        await createFreeTextAnnotation(page, 'page-three-note', {
            x: 0.45,
            y: 0.32,
        }, 3);

        const pageOneEditors = await countFreeTextEditorsOnPage(page, 1);
        const pageThreeEditors = await countFreeTextEditorsOnPage(page, 3);
        expect(pageOneEditors).toBeGreaterThan(0);
        expect(pageThreeEditors).toBeGreaterThan(0);
    });
});
