import {
    describe,
    expect,
    it,
} from 'vitest';
import { copyProjectFixture } from './helpers/fixtures';
import { startElectronE2ESession } from './helpers/session-harness';
import {
    clickAnnotationTool,
    createFreeTextAnnotation,
    dragMarker,
    getConnectorPaths,
    getMarkers,
    getNoteWindowTextareaPoint,
    getRenderedPageCount,
    openAnnotationsTab,
    openPdfInApp,
    parsePathStart,
    saveViaWindowHandle,
    waitForPdfLoaded,
} from './helpers/viewer-helpers';

describe('Electron E2E - Phase 4 (Marker Regression)', () => {
    it('drags marker, preserves note text, and avoids rerender on save', async () => {
        const fixturePath = copyProjectFixture('generated-text.pdf', `phase4-marker-${Date.now()}.pdf`);
        const session = await startElectronE2ESession(`e2e-phase4-${Date.now()}`);

        try {
            await openPdfInApp(session.page, fixturePath);
            await waitForPdfLoaded(session.page);
            await openAnnotationsTab(session.page);

            await createFreeTextAnnotation(session.page, `phase4-base-${Date.now()}`);
            await clickAnnotationTool(session.page, 'Select');

            const markersBefore = await getMarkers(session.page);
            expect(markersBefore.length).toBeGreaterThan(0);
            const firstMarker = markersBefore[0]!;
            expect(firstMarker.key.length).toBeGreaterThan(0);

            await session.page.mouse.click(firstMarker.cx, firstMarker.cy);
            await session.page.waitForFunction(() => Boolean(document.querySelector('.pdf-annotation-note-window textarea, [class*="note-window"] textarea')), {timeout: 4_000});

            const connectorsBefore = await getConnectorPaths(session.page);
            const dragResult = await dragMarker(session.page, firstMarker.key, 120, -80);
            expect(dragResult).not.toBeNull();

            const markersAfterDrag = await getMarkers(session.page);
            const movedMarker = markersAfterDrag.find(marker => marker.key === firstMarker.key);
            expect(movedMarker).toBeDefined();
            expect(Math.abs((movedMarker?.cx ?? 0) - firstMarker.cx)).toBeGreaterThan(30);
            expect(Math.abs((movedMarker?.cy ?? 0) - firstMarker.cy)).toBeGreaterThan(30);

            const connectorsAfterDrag = await getConnectorPaths(session.page);
            if (connectorsBefore.length > 0 && connectorsAfterDrag.length > 0) {
                const startBefore = parsePathStart(connectorsBefore[0]!);
                const startAfter = parsePathStart(connectorsAfterDrag[0]!);
                expect(startBefore).not.toBeNull();
                expect(startAfter).not.toBeNull();
                expect(Math.abs((startAfter?.x ?? 0) - (startBefore?.x ?? 0)) > 5
                    || Math.abs((startAfter?.y ?? 0) - (startBefore?.y ?? 0)) > 5).toBe(true);
            }

            if (movedMarker) {
                await session.page.mouse.click(movedMarker.cx, movedMarker.cy);
                await session.page.waitForFunction(
                    () => Boolean(document.querySelector('.pdf-annotation-note-window textarea, [class*="note-window"] textarea')),
                    {timeout: 4_000},
                );
            }

            const editText = `edited-${Date.now()}`;
            const textAreaPoint = await getNoteWindowTextareaPoint(session.page);
            expect(textAreaPoint).not.toBeNull();

            if (textAreaPoint) {
                await session.page.mouse.click(textAreaPoint.x, textAreaPoint.y);
                await session.page.evaluate((nextText: string) => {
                    const textarea = document.querySelector<HTMLTextAreaElement>(
                        '.pdf-annotation-note-window textarea, [class*="note-window"] textarea',
                    );
                    if (!textarea) {
                        return false;
                    }
                    textarea.focus();
                    textarea.value = nextText;
                    textarea.dispatchEvent(new InputEvent('input', {
                        bubbles: true,
                        composed: true,
                    }));
                    textarea.dispatchEvent(new Event('change', {
                        bubbles: true,
                        composed: true,
                    }));
                    return true;
                }, editText);
            }

            const canvasCountBefore = await getRenderedPageCount(session.page);
            expect(canvasCountBefore).toBeGreaterThan(0);

            await session.page.evaluate(() => {
                const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
                    ?? null;

                const root = window as Window & {
                    __e2eCanvasRemoveCount?: number;
                    __e2eMutationObserver?: MutationObserver;
                };
                root.__e2eCanvasRemoveCount = 0;

                if (host) {
                    const observer = new MutationObserver((mutations) => {
                        for (const mutation of mutations) {
                            for (const removed of mutation.removedNodes) {
                                if (removed instanceof HTMLCanvasElement
                                    || (removed instanceof HTMLElement && removed.querySelector('canvas'))) {
                                    root.__e2eCanvasRemoveCount = (root.__e2eCanvasRemoveCount ?? 0) + 1;
                                }
                            }
                        }
                    });
                    observer.observe(host, {
                        childList: true,
                        subtree: true,
                    });
                    root.__e2eMutationObserver = observer;
                }
            });

            await saveViaWindowHandle(session.page);

            const canvasRemoveCount = await session.page.evaluate(() => {
                const root = window as Window & {
                    __e2eCanvasRemoveCount?: number;
                    __e2eMutationObserver?: MutationObserver;
                };
                root.__e2eMutationObserver?.disconnect();
                return root.__e2eCanvasRemoveCount ?? 0;
            });
            const textAfterSave = await session.page.evaluate(() => {
                const textarea = document.querySelector<HTMLTextAreaElement>(
                    '.pdf-annotation-note-window textarea, [class*="note-window"] textarea',
                );
                return textarea?.value ?? null;
            });
            const markersAfterSave = await getMarkers(session.page);
            const savedMarker = markersAfterSave.find(marker => marker.key === firstMarker.key);
            const canvasCountAfter = await getRenderedPageCount(session.page);

            expect(canvasRemoveCount).toBe(0);
            expect(canvasCountAfter).toBe(canvasCountBefore);
            expect(textAfterSave).toContain(editText);
            expect(savedMarker).toBeDefined();
            expect(Math.abs((savedMarker?.cx ?? 0) - (movedMarker?.cx ?? 0))).toBeLessThan(20);
            expect(Math.abs((savedMarker?.cy ?? 0) - (movedMarker?.cy ?? 0))).toBeLessThan(20);
            expect(Math.abs((savedMarker?.cx ?? 0) - firstMarker.cx) < 15
                && Math.abs((savedMarker?.cy ?? 0) - firstMarker.cy) < 15).toBe(false);
        } finally {
            await session.stop();
        }
    });
});
