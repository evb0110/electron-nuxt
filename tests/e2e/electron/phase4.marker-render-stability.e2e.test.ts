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
    dragMarker,
    getMarkers,
    getRenderedPageCount,
    openAnnotationsTab,
    openPdfInApp,
    saveViaWindowHandle,
    waitForPdfLoaded,
} from './helpers/viewer-helpers';

describe('Electron E2E - Phase 4 (Marker Save Render Stability)', () => {
    it('does not trigger full document rerender on save after marker drag', async () => {
        const fixturePath = copyProjectFixture('generated-text.pdf', `phase4-render-${Date.now()}.pdf`);
        const session = await startElectronE2ESession(`e2e-phase4-render-${Date.now()}`);

        try {
            await openPdfInApp(session.page, fixturePath);
            await waitForPdfLoaded(session.page);
            await openAnnotationsTab(session.page);

            await createFreeTextAnnotation(session.page, `phase4-render-${Date.now()}`);
            await clickAnnotationTool(session.page, 'Select');
            await delay(900);

            const markers = await getMarkers(session.page);
            expect(markers.length).toBeGreaterThan(0);
            const firstMarker = markers[0]!;

            await dragMarker(session.page, firstMarker.key, 80, -50);

            const canvasCountBefore = await getRenderedPageCount(session.page);
            expect(canvasCountBefore).toBeGreaterThan(0);

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

            await saveViaWindowHandle(session.page);
            await delay(1_800);

            const canvasRemoveCount = await session.page.evaluate(() => {
                const root = window as Window & {
                    __e2eCanvasRemoveCount?: number;
                    __e2eMutationObserver?: MutationObserver;
                };
                root.__e2eMutationObserver?.disconnect();
                return root.__e2eCanvasRemoveCount ?? 0;
            });

            const canvasCountAfter = await getRenderedPageCount(session.page);
            expect(canvasRemoveCount).toBe(0);
            expect(canvasCountAfter).toBe(canvasCountBefore);
        } finally {
            await session.stop();
        }
    });
});
