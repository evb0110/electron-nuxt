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
    openAnnotationsTab,
    openPdfInApp,
    parsePathStart,
    saveViaWindowHandle,
    waitForPdfLoaded,
} from './helpers/viewer-helpers';

describe('Electron E2E - Phase 4 (Marker Drag Persistence)', () => {
    it('drags marker, connector follows, and position persists through save', async () => {
        const fixturePath = copyProjectFixture('generated-text.pdf', `phase4-drag-${Date.now()}.pdf`);
        const session = await startElectronE2ESession(`e2e-phase4-drag-${Date.now()}`);

        try {
            await openPdfInApp(session.page, fixturePath);
            await waitForPdfLoaded(session.page);
            await openAnnotationsTab(session.page);

            await createFreeTextAnnotation(session.page, `phase4-drag-test-${Date.now()}`);
            await clickAnnotationTool(session.page, 'Select');
            
            const markersBefore = await getMarkers(session.page);
            expect(markersBefore.length).toBeGreaterThan(0);
            const firstMarker = markersBefore[0]!;
            expect(firstMarker.key.length).toBeGreaterThan(0);

            await session.page.mouse.click(firstMarker.cx, firstMarker.cy);
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

            await saveViaWindowHandle(session.page);
            const markersAfterSave = await getMarkers(session.page);
            const savedMarker = markersAfterSave.find(marker => marker.key === firstMarker.key);
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
