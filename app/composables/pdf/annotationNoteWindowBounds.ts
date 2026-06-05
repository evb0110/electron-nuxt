import { NOTE_WINDOW } from '@app/constants/pdfLayout';
import { clamp } from 'es-toolkit/math';

export interface IAnnotationNoteWindowBounds {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
}

export function clampAnnotationNoteWindowSize(
    nextWidth: number,
    nextHeight: number,
    bounds: IAnnotationNoteWindowBounds | null,
) {
    if (!bounds) {
        return {
            width: Math.max(NOTE_WINDOW.MIN_WIDTH, Math.round(nextWidth)),
            height: Math.max(NOTE_WINDOW.MIN_HEIGHT, Math.round(nextHeight)),
        };
    }

    const maxWidth = Math.max(NOTE_WINDOW.MIN_WIDTH, bounds.width - (NOTE_WINDOW.MARGIN * 2));
    const maxHeight = Math.max(NOTE_WINDOW.MIN_HEIGHT, bounds.height - (NOTE_WINDOW.MARGIN * 2));

    return {
        width: clamp(Math.round(nextWidth), NOTE_WINDOW.MIN_WIDTH, maxWidth),
        height: clamp(Math.round(nextHeight), NOTE_WINDOW.MIN_HEIGHT, maxHeight),
    };
}

export function clampAnnotationNoteWindowPosition(
    x: number,
    y: number,
    nextWidth: number,
    nextHeight: number,
    bounds: IAnnotationNoteWindowBounds | null,
) {
    if (!bounds) {
        return {
            x,
            y,
        };
    }

    const minX = bounds.left + NOTE_WINDOW.MARGIN;
    const minY = bounds.top + NOTE_WINDOW.MARGIN;
    const maxX = Math.max(minX, bounds.right - nextWidth - NOTE_WINDOW.MARGIN);
    const maxY = Math.max(minY, bounds.bottom - nextHeight - NOTE_WINDOW.MARGIN);

    return {
        x: Math.round(clamp(x, minX, maxX)),
        y: Math.round(clamp(y, minY, maxY)),
    };
}
