import { delay } from 'es-toolkit/promise';
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
    openAnnotationsTab,
    openPdfInApp,
    saveViaWindowHandle,
    waitForPdfLoaded,
} from './helpers/viewer-helpers';
import type { Page } from 'puppeteer-core';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

interface IPoint {
    x: number;
    y: number;
}

interface IMarkerInfo {
    key: string;
    cx: number;
    cy: number;
}

async function getMarkers(page: Page): Promise<IMarkerInfo[]> {
    return page.evaluate(() => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
        if (!host) {
            return [];
        }
        return Array.from(host.querySelectorAll<HTMLElement>('.pdf-comment-marker-button')).map((marker) => {
            const rect = marker.getBoundingClientRect();
            return {
                key: marker.dataset.stableKey ?? '',
                cx: Math.round(rect.x + rect.width / 2),
                cy: Math.round(rect.y + rect.height / 2),
            };
        });
    });
}

async function getConnectorPaths(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
        if (!host) {
            return [];
        }
        return Array.from(host.querySelectorAll<SVGPathElement>('path'))
            .filter(pathEl => (pathEl.getAttribute('d') ?? '').match(/^M .+ L /))
            .map(pathEl => pathEl.getAttribute('d') ?? '');
    });
}

function parsePathStart(pathData: string): IPoint | null {
    const match = pathData.match(/^M\s+([\d.]+)\s+([\d.]+)/);
    if (!match?.[1] || !match[2]) {
        return null;
    }
    return {
        x: parseFloat(match[1]),
        y: parseFloat(match[2]),
    };
}

async function dragMarker(page: Page, stableKey: string, dx: number, dy: number) {
    const result = await page.evaluate(async (targetKey: string, deltaX: number, deltaY: number) => {
        const marker = document.querySelector<HTMLElement>(
            `.pdf-comment-marker-button[data-stable-key="${targetKey}"]`,
        );
        if (!marker) {
            return null;
        }

        const rect = marker.getBoundingClientRect();
        const startX = rect.x + rect.width / 2;
        const startY = rect.y + rect.height / 2;

        marker.dispatchEvent(new PointerEvent('pointerdown', {
            clientX: startX,
            clientY: startY,
            button: 0,
            pointerId: 1,
            bubbles: true,
            composed: true,
        }));

        await new Promise(resolve => setTimeout(resolve, 50));

        const steps = 12;
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            marker.dispatchEvent(new PointerEvent('pointermove', {
                clientX: startX + deltaX * t,
                clientY: startY + deltaY * t,
                button: 0,
                pointerId: 1,
                bubbles: true,
                composed: true,
            }));
            await new Promise(resolve => setTimeout(resolve, 20));
        }

        marker.dispatchEvent(new PointerEvent('pointerup', {
            clientX: startX + deltaX,
            clientY: startY + deltaY,
            button: 0,
            pointerId: 1,
            bubbles: true,
            composed: true,
        }));

        return {
            startX: Math.round(startX),
            startY: Math.round(startY),
            endX: Math.round(startX + deltaX),
            endY: Math.round(startY + deltaY),
        } as const;
    }, stableKey, dx, dy);

    await delay(500);
    return result;
}

async function getNoteWindowTextarea(page: Page): Promise<IPoint | null> {
    return page.evaluate(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>(
            '.pdf-annotation-note-window textarea, [class*="note-window"] textarea',
        );
        if (!textarea) {
            return null;
        }
        textarea.focus();
        const rect = textarea.getBoundingClientRect();
        return {
            x: rect.x + 10,
            y: rect.y + 10,
        };
    });
}

async function getRenderedPageCount(page: Page): Promise<number> {
    return page.evaluate(() => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
        return host?.querySelectorAll('.page_container canvas').length ?? 0;
    });
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('Electron E2E - Phase 4 (Marker Drag)', () => {
    it('drags marker to new position, connector follows, and position persists through save', async () => {
        const fixturePath = copyProjectFixture('generated-text.pdf', `phase4-drag-${Date.now()}.pdf`);
        const session = await startElectronE2ESession(`e2e-phase4-drag-${Date.now()}`);

        try {
            await openPdfInApp(session.page, fixturePath);
            await waitForPdfLoaded(session.page);
            await openAnnotationsTab(session.page);

            // Create a FreeText annotation that produces a note marker
            await createFreeTextAnnotation(session.page, `phase4-drag-test-${Date.now()}`);
            await clickAnnotationTool(session.page, 'Select');
            await delay(1000);

            // Verify at least one marker appeared
            const markersBefore = await getMarkers(session.page);
            const firstMarker = markersBefore[0];
            expect(firstMarker).toBeDefined();
            if (!firstMarker) {
                return;
            }

            const targetKey = firstMarker.key;
            const originalPos = firstMarker;

            // Get connector paths before drag
            const connectorsBefore = await getConnectorPaths(session.page);

            // ── Drag the marker ──────────────────────────────────────────────
            const dragResult = await dragMarker(session.page, targetKey, 120, -80);
            expect(dragResult).not.toBeNull();

            // Verify marker moved to the new position
            const markersAfterDrag = await getMarkers(session.page);
            const movedMarker = markersAfterDrag.find(m => m.key === targetKey);
            expect(movedMarker).toBeDefined();

            const markerMoved = movedMarker
                ? Math.abs(movedMarker.cx - originalPos.cx) > 30 || Math.abs(movedMarker.cy - originalPos.cy) > 30
                : false;
            expect(markerMoved).toBe(true);

            // ── Connector line should have followed ──────────────────────────
            const connectorsAfterDrag = await getConnectorPaths(session.page);
            const connBefore = connectorsBefore[0];
            const connAfter = connectorsAfterDrag[0];
            if (connBefore && connAfter) {
                const startBefore = parsePathStart(connBefore);
                const startAfter = parsePathStart(connAfter);
                if (startBefore && startAfter) {
                    const connectorMoved = Math.abs(startAfter.x - startBefore.x) > 5
                        || Math.abs(startAfter.y - startBefore.y) > 5;
                    expect(connectorMoved).toBe(true);
                }
            }

            // ── Save the document ────────────────────────────────────────────
            await saveViaWindowHandle(session.page);
            await delay(1500);

            // ── Marker should not jump back to original position ─────────────
            const markersAfterSave = await getMarkers(session.page);
            const savedMarker = markersAfterSave.find(m => m.key === targetKey);
            expect(savedMarker).toBeDefined();

            if (savedMarker && movedMarker) {
                const stayedAtDraggedPos = Math.abs(savedMarker.cx - movedMarker.cx) < 20
                    && Math.abs(savedMarker.cy - movedMarker.cy) < 20;
                expect(stayedAtDraggedPos).toBe(true);

                const jumpedBack = Math.abs(savedMarker.cx - originalPos.cx) < 15
                    && Math.abs(savedMarker.cy - originalPos.cy) < 15;
                expect(jumpedBack).toBe(false);
            }
        } finally {
            await session.stop();
        }
    });

    it('preserves note text when editing a moved note and saving', async () => {
        const fixturePath = copyProjectFixture('generated-text.pdf', `phase4-text-${Date.now()}.pdf`);
        const session = await startElectronE2ESession(`e2e-phase4-text-${Date.now()}`);

        try {
            await openPdfInApp(session.page, fixturePath);
            await waitForPdfLoaded(session.page);
            await openAnnotationsTab(session.page);

            // Create a FreeText annotation with a note
            await createFreeTextAnnotation(session.page, `phase4-base-${Date.now()}`);
            await clickAnnotationTool(session.page, 'Select');
            await delay(1000);

            const markers = await getMarkers(session.page);
            const firstMarker2 = markers[0];
            expect(firstMarker2).toBeDefined();
            if (!firstMarker2) {
                return;
            }

            const targetKey = firstMarker2.key;

            // Click marker to open the note window
            await session.page.mouse.click(firstMarker2.cx, firstMarker2.cy);
            await delay(1000);

            // Drag the marker to a new position
            const dragResult = await dragMarker(session.page, targetKey, 100, 60);
            expect(dragResult).not.toBeNull();

            // Reopen the note by clicking at the marker's new position
            const markersAfterDrag = await getMarkers(session.page);
            const movedMarker = markersAfterDrag.find(m => m.key === targetKey);
            expect(movedMarker).toBeDefined();

            if (movedMarker) {
                await session.page.mouse.click(movedMarker.cx, movedMarker.cy);
                await delay(800);
            }

            // Type text into the note
            const editText = `edited-${Date.now()}`;
            const textarea = await getNoteWindowTextarea(session.page);
            if (textarea) {
                await session.page.mouse.click(textarea.x, textarea.y);
                await delay(200);
                // Select all existing text and replace it
                await session.page.keyboard.down('Meta');
                await session.page.keyboard.press('a');
                await session.page.keyboard.up('Meta');
                await session.page.keyboard.type(editText, { delay: 15 });
                await delay(500);
            }

            // Save the document
            await saveViaWindowHandle(session.page);
            await delay(2000);

            // Verify note text was preserved after save (not reset)
            const textAfterSave = await session.page.evaluate(() => {
                const ta = document.querySelector<HTMLTextAreaElement>(
                    '.pdf-annotation-note-window textarea, [class*="note-window"] textarea',
                );
                return ta?.value ?? null;
            });

            // The text should still contain our edit, not be reset to original
            if (textAfterSave !== null) {
                expect(textAfterSave).toContain(editText);
            }

            // Marker should still be at dragged position, not jumped back
            const markersAfterSave = await getMarkers(session.page);
            const finalMarker = markersAfterSave.find(m => m.key === targetKey);
            expect(finalMarker).toBeDefined();

            if (finalMarker && movedMarker) {
                const stayedAtDraggedPos = Math.abs(finalMarker.cx - movedMarker.cx) < 20
                    && Math.abs(finalMarker.cy - movedMarker.cy) < 20;
                expect(stayedAtDraggedPos).toBe(true);
            }
        } finally {
            await session.stop();
        }
    });

    it('does not trigger a full document re-render on save after marker drag', async () => {
        const fixturePath = copyProjectFixture('generated-text.pdf', `phase4-render-${Date.now()}.pdf`);
        const session = await startElectronE2ESession(`e2e-phase4-render-${Date.now()}`);

        try {
            await openPdfInApp(session.page, fixturePath);
            await waitForPdfLoaded(session.page);
            await openAnnotationsTab(session.page);

            // Create a FreeText annotation
            await createFreeTextAnnotation(session.page, `phase4-render-${Date.now()}`);
            await clickAnnotationTool(session.page, 'Select');
            await delay(1000);

            const markers3 = await getMarkers(session.page);
            const firstMarker3 = markers3[0];
            expect(firstMarker3).toBeDefined();
            if (!firstMarker3) {
                return;
            }

            const targetKey = firstMarker3.key;

            // Drag the marker
            await dragMarker(session.page, targetKey, 80, -50);

            // Snapshot page state before save: record canvas count and install mutation observer
            const canvasCountBefore = await getRenderedPageCount(session.page);

            await session.page.evaluate(() => {
                const host = Array.from(document.querySelectorAll('.workspace-host'))
                    .find((candidate) => {
                        const element = candidate as HTMLElement;
                        const rect = element.getBoundingClientRect();
                        const style = window.getComputedStyle(element);
                        return style.display !== 'none' && rect.width > 100 && rect.height > 100;
                    }) as HTMLElement | undefined;

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

            // Save the document
            await saveViaWindowHandle(session.page);
            await delay(2000);

            // Check that no canvases were removed/re-added (which would indicate a full re-render)
            const canvasRemoveCount = await session.page.evaluate(() => {
                const root = window as Window & {
                    __e2eCanvasRemoveCount?: number;
                    __e2eMutationObserver?: MutationObserver;
                };
                root.__e2eMutationObserver?.disconnect();
                return root.__e2eCanvasRemoveCount ?? 0;
            });

            const canvasCountAfter = await getRenderedPageCount(session.page);

            // No canvases should have been removed during save (which would indicate document reload)
            expect(canvasRemoveCount).toBe(0);
            expect(canvasCountAfter).toBe(canvasCountBefore);
        } finally {
            await session.stop();
        }
    });
});
