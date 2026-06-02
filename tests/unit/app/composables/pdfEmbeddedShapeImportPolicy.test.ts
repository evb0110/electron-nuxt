import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    EMBEDDED_SHAPE_IMPORT_INITIAL_RENDER_MAX_BYTES,
    resolveEmbeddedShapeImportLoadPolicy,
} from '@app/composables/pdf/pdfEmbeddedShapeImportPolicy';

describe('resolveEmbeddedShapeImportLoadPolicy', () => {
    it('awaits path-backed embedded drawings before the first page render', () => {
        expect(resolveEmbeddedShapeImportLoadPolicy(null, '/tmp/book.pdf')).toEqual({
            awaitBeforeInitialRender: true,
            deferUntilAfterInitialRender: false,
        });
    });

    it('awaits small byte-backed embedded drawings before the first page render', () => {
        expect(resolveEmbeddedShapeImportLoadPolicy(new Uint8Array([1]), null)).toEqual({
            awaitBeforeInitialRender: true,
            deferUntilAfterInitialRender: false,
        });
    });

    it('defers large byte-backed embedded drawing imports until after the first page render', () => {
        expect(resolveEmbeddedShapeImportLoadPolicy(
            new Uint8Array(EMBEDDED_SHAPE_IMPORT_INITIAL_RENDER_MAX_BYTES + 1),
            '/tmp/large-book.pdf',
        )).toEqual({
            awaitBeforeInitialRender: false,
            deferUntilAfterInitialRender: true,
        });
    });
});
