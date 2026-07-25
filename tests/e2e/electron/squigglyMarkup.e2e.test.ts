import {
    describe,
    expect,
    it,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import type { Page } from 'puppeteer-core';
import {
    createMultiPageTextFixturePdf,
    readPdfAnnotationSummary,
} from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    clickAnnotationTool,
    getHighlightEditorCount,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    openAnnotationsTab,
    openPdfInApp,
    saveViaWindowHandle,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    callWorkspaceCommand,
    getWorkspaceToolbarSnapshot,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';

async function dragOverFirstTwoSpans(page: Page) {
    const dragPoints = await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const spans = Array.from(host?.querySelectorAll<HTMLElement>(
            '.page_container .text-layer span, .page_container .textLayer span',
        ) ?? []).filter(span => (span.textContent ?? '').trim().length > 0);
        const first = spans[0]?.getBoundingClientRect();
        const second = (spans[1] ?? spans[0])?.getBoundingClientRect();
        if (!first || !second) {
            return null;
        }
        return {
            x1: Math.round(first.left + 2),
            y1: Math.round(first.top + first.height / 2),
            x2: Math.round(second.right - 2),
            y2: Math.round(second.top + second.height / 2),
        };
    });
    if (!dragPoints) {
        throw new Error('Unable to locate visible text spans for squiggly creation');
    }
    await page.mouse.move(dragPoints.x1, dragPoints.y1);
    await page.mouse.down();
    await page.mouse.move(dragPoints.x2, dragPoints.y2, { steps: 8 });
    await page.mouse.up();
}

async function waitForPdfAnnotationSubtypeCount(filePath: string, subtype: string, expectedCount: number) {
    const startedAt = Date.now();
    let lastSummary = await readPdfAnnotationSummary(filePath);
    while (Date.now() - startedAt < 20_000) {
        if ((lastSummary.bySubtype[subtype] ?? 0) === expectedCount) {
            return lastSummary;
        }
        await delay(150);
        lastSummary = await readPdfAnnotationSummary(filePath);
    }
    throw new Error(
        `Expected ${expectedCount} ${subtype} annotation(s) on disk, got ${lastSummary.bySubtype[subtype] ?? 0} `
        + `(subtypes: ${JSON.stringify(lastSummary.bySubtype)})`,
    );
}

// The presentation controller owns every markup repaint, so a healthy surface has
// one ready editor per markup, one draw visual set, and a single stroke colour.
async function readMarkupPresentationState(page: Page) {
    return page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const editors = Array.from(host?.querySelectorAll<HTMLElement>('.highlightEditor') ?? []);
        const visuals = Array.from(host?.querySelectorAll<SVGElement>('.pdf-markup-subtype-draw-visual') ?? []);
        return {
            editorCount: editors.length,
            readyCount: editors.filter(editor => editor.classList.contains('pdf-markup-subtype-visual-ready')).length,
            squigglyCount: editors.filter(editor => editor.dataset.markupSubtype === 'squiggly').length,
            strokes: Array.from(new Set(visuals.map(visual =>
                visual.querySelector('path')?.getAttribute('stroke') ?? '',
            ))).sort(),
            visualCount: visuals.length,
        };
    });
}

async function createSquigglyOverFirstSpans(page: Page) {
    const before = await getHighlightEditorCount(page);
    await clickAnnotationTool(page, 'Squiggly');
    await dragOverFirstTwoSpans(page);
    await page.waitForFunction((previousCount: number) => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        return (host?.querySelectorAll('.highlightEditor').length ?? 0) > previousCount;
    }, { timeout: 20_000 }, before);
}

describe('Electron E2E - Squiggly text markup', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        restartBeforeEach: true,
        sessionName: () => `e2e-squiggly-${Date.now()}`,
    });

    it('authors and persists a Squiggly annotation that survives save', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const { page } = session;

        const fixturePath = await createMultiPageTextFixturePdf(`squiggly-${Date.now()}-squiggly.pdf`, 1);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);

        await createSquigglyOverFirstSpans(page);

        await saveViaWindowHandle(page);

        const summary = await waitForPdfAnnotationSubtypeCount(fixturePath, 'Squiggly', 1);
        expect(summary.bySubtype.Squiggly ?? 0).toBe(1);
        // The squiggly must be a genuine Squiggly subtype, not a fallback Highlight.
        expect(summary.bySubtype.Highlight ?? 0).toBe(0);
    });

    it('keeps markup visuals correct and unduplicated through rapid zoom changes', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const { page } = session;

        const fixturePath = await createMultiPageTextFixturePdf(`squiggly-zoom-${Date.now()}-squiggly.pdf`, 1);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);
        await createSquigglyOverFirstSpans(page);

        await page.waitForFunction(() => {
            const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            return (host?.querySelectorAll('.pdf-markup-subtype-draw-visual').length ?? 0) > 0;
        }, { timeout: 20_000 });
        const baseline = await readMarkupPresentationState(page);
        expect(baseline.squigglyCount).toBe(1);
        expect(baseline.readyCount).toBe(baseline.editorCount);
        expect(baseline.visualCount).toBeGreaterThan(0);
        expect(baseline.strokes).toHaveLength(1);

        // Zoom faster than any settle: the controller must still converge on one
        // correctly-coloured visual set instead of stale or duplicated markup.
        const zoomLevels = [
            2.5,
            0.75,
            3.5,
            1.25,
            4,
            0.5,
        ];
        for (const zoom of zoomLevels) {
            const zoomResult = await callWorkspaceCommand(page, 'setCustomZoomFromDisplay', [zoom]);
            expect(zoomResult.called).toBe(true);
        }
        await waitForWorkspaceToolbarSnapshot(page, {minEffectiveZoom: 0.49}, {timeoutMs: 20_000});
        await delay(1_600);
        const finalToolbar = await getWorkspaceToolbarSnapshot(page);
        expect(finalToolbar?.effectiveZoom).toBe(0.5);

        const settled = await readMarkupPresentationState(page);
        expect(settled.editorCount).toBe(baseline.editorCount);
        expect(settled.squigglyCount).toBe(baseline.squigglyCount);
        expect(settled.readyCount).toBe(settled.editorCount);
        expect(settled.visualCount).toBe(baseline.visualCount);
        expect(settled.strokes).toEqual(baseline.strokes);
    });
});
