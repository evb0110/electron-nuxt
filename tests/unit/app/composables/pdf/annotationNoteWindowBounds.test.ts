import {
    describe,
    expect,
    it,
} from 'vitest';
import { NOTE_WINDOW } from '@app/constants/pdfLayout';
import {
    clampAnnotationNoteWindowPosition,
    clampAnnotationNoteWindowSize,
    type IAnnotationNoteWindowBounds,
} from '@app/composables/pdf/annotationNoteWindowBounds';

const PDF_VIEWER_BOUNDS: IAnnotationNoteWindowBounds = {
    left: 40,
    top: 220,
    right: 1040,
    bottom: 920,
    width: 1000,
    height: 700,
};

describe('annotationNoteWindowBounds', () => {
    it('keeps a floating note below the PDF viewer top edge', () => {
        expect(clampAnnotationNoteWindowPosition(
            56,
            12,
            NOTE_WINDOW.DEFAULT_WIDTH,
            NOTE_WINDOW.DEFAULT_HEIGHT,
            PDF_VIEWER_BOUNDS,
        )).toEqual({
            x: 56,
            y: PDF_VIEWER_BOUNDS.top + NOTE_WINDOW.MARGIN,
        });
    });

    it('keeps a floating note inside the PDF viewer right and bottom edges', () => {
        expect(clampAnnotationNoteWindowPosition(
            980,
            900,
            NOTE_WINDOW.DEFAULT_WIDTH,
            NOTE_WINDOW.DEFAULT_HEIGHT,
            PDF_VIEWER_BOUNDS,
        )).toEqual({
            x: PDF_VIEWER_BOUNDS.right - NOTE_WINDOW.DEFAULT_WIDTH - NOTE_WINDOW.MARGIN,
            y: PDF_VIEWER_BOUNDS.bottom - NOTE_WINDOW.DEFAULT_HEIGHT - NOTE_WINDOW.MARGIN,
        });
    });

    it('limits resized note dimensions to the PDF viewer bounds', () => {
        expect(clampAnnotationNoteWindowSize(
            2000,
            2000,
            PDF_VIEWER_BOUNDS,
        )).toEqual({
            width: PDF_VIEWER_BOUNDS.width - (NOTE_WINDOW.MARGIN * 2),
            height: PDF_VIEWER_BOUNDS.height - (NOTE_WINDOW.MARGIN * 2),
        });
    });
});

