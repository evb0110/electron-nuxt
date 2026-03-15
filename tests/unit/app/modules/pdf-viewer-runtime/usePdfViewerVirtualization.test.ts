import {
    describe,
    expect,
    it,
} from 'vitest';
import { expandVirtualWindowForAnchor } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerVirtualization';

describe('expandVirtualWindowForAnchor', () => {
    it('keeps the existing window when no anchor page is provided', () => {
        expect(expandVirtualWindowForAnchor({
            baseStart: 10,
            baseEnd: 20,
            anchorPage: null,
            totalPages: 100,
            buffer: 6,
        })).toEqual({
            start: 10,
            end: 20,
        });
    });

    it('expands the window to keep the resize anchor page mounted', () => {
        expect(expandVirtualWindowForAnchor({
            baseStart: 40,
            baseEnd: 52,
            anchorPage: 30,
            totalPages: 100,
            buffer: 6,
        })).toEqual({
            start: 24,
            end: 52,
        });
    });

    it('clamps the expanded window into the document bounds', () => {
        expect(expandVirtualWindowForAnchor({
            baseStart: 3,
            baseEnd: 10,
            anchorPage: 1,
            totalPages: 12,
            buffer: 8,
        })).toEqual({
            start: 1,
            end: 10,
        });
    });
});
