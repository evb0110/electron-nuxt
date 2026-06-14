import {
    describe,
    expect,
    it,
} from 'vitest';
import { shouldShowShapeOverlay } from '@app/modules/pdf-viewer/engine/pdf-shape-overlay-visibility/shouldShowShapeOverlay';

describe('shouldShowShapeOverlay', () => {
    it('hides stored shapes until the page has a rendered visual backing', () => {
        expect(shouldShowShapeOverlay({
            hasDrawingShape: false,
            hasPageShapes: true,
            isPageVisualReady: false,
            isShapeToolActive: false,
        })).toBe(false);
    });

    it('shows stored shapes once the page visual is ready', () => {
        expect(shouldShowShapeOverlay({
            hasDrawingShape: false,
            hasPageShapes: true,
            isPageVisualReady: true,
            isShapeToolActive: false,
        })).toBe(true);
    });

    it('keeps an in-progress drawing visible even if render state changes', () => {
        expect(shouldShowShapeOverlay({
            hasDrawingShape: true,
            hasPageShapes: false,
            isPageVisualReady: false,
            isShapeToolActive: true,
        })).toBe(true);
    });

    it('only enables shape authoring when the page visual is ready', () => {
        expect(shouldShowShapeOverlay({
            hasDrawingShape: false,
            hasPageShapes: false,
            isPageVisualReady: false,
            isShapeToolActive: true,
        })).toBe(false);

        expect(shouldShowShapeOverlay({
            hasDrawingShape: false,
            hasPageShapes: false,
            isPageVisualReady: true,
            isShapeToolActive: true,
        })).toBe(true);
    });
});
