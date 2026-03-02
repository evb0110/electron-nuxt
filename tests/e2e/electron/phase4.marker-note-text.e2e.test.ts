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
    getNoteWindowTextareaPoint,
    openAnnotationsTab,
    openPdfInApp,
    saveViaWindowHandle,
    waitForPdfLoaded,
} from './helpers/viewer-helpers';

describe('Electron E2E - Phase 4 (Marker Note Text)', () => {
    it('preserves edited note text after marker move and save', async () => {
        const fixturePath = copyProjectFixture('generated-text.pdf', `phase4-text-${Date.now()}.pdf`);
        const session = await startElectronE2ESession(`e2e-phase4-text-${Date.now()}`);

        try {
            await openPdfInApp(session.page, fixturePath);
            await waitForPdfLoaded(session.page);
            await openAnnotationsTab(session.page);

            await createFreeTextAnnotation(session.page, `phase4-base-${Date.now()}`);
            await clickAnnotationTool(session.page, 'Select');
            await delay(900);

            const markersBefore = await getMarkers(session.page);
            expect(markersBefore.length).toBeGreaterThan(0);
            const firstMarker = markersBefore[0]!;

            await session.page.mouse.click(firstMarker.cx, firstMarker.cy);
            await delay(700);

            const dragResult = await dragMarker(session.page, firstMarker.key, 100, 60);
            expect(dragResult).not.toBeNull();

            const markersAfterDrag = await getMarkers(session.page);
            const movedMarker = markersAfterDrag.find(marker => marker.key === firstMarker.key);
            expect(movedMarker).toBeDefined();

            if (movedMarker) {
                await session.page.mouse.click(movedMarker.cx, movedMarker.cy);
                await delay(600);
            }

            const editText = `edited-${Date.now()}`;
            const textAreaPoint = await getNoteWindowTextareaPoint(session.page);
            expect(textAreaPoint).not.toBeNull();

            if (textAreaPoint) {
                await session.page.mouse.click(textAreaPoint.x, textAreaPoint.y);
                await delay(100);
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

            await saveViaWindowHandle(session.page);
            await delay(1_700);

            const textAfterSave = await session.page.evaluate(() => {
                const textarea = document.querySelector<HTMLTextAreaElement>(
                    '.pdf-annotation-note-window textarea, [class*="note-window"] textarea',
                );
                return textarea?.value ?? null;
            });
            expect(textAfterSave).toContain(editText);

            const markersAfterSave = await getMarkers(session.page);
            const finalMarker = markersAfterSave.find(marker => marker.key === firstMarker.key);
            expect(finalMarker).toBeDefined();
            expect(Math.abs((finalMarker?.cx ?? 0) - (movedMarker?.cx ?? 0))).toBeLessThan(20);
            expect(Math.abs((finalMarker?.cy ?? 0) - (movedMarker?.cy ?? 0))).toBeLessThan(20);
        } finally {
            await session.stop();
        }
    });
});
