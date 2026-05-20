import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveEmbeddedShapeImportLoadPolicy } from '@app/composables/pdf/pdfEmbeddedShapeImportPolicy';

describe('resolveEmbeddedShapeImportLoadPolicy', () => {
    it('awaits path-backed embedded drawings before the first page render', () => {
        expect(resolveEmbeddedShapeImportLoadPolicy(null, '/tmp/book.pdf')).toEqual({
            awaitBeforeInitialRender: true,
            deferUntilAfterInitialRender: false,
        });
    });

    it('awaits byte-backed embedded drawings before the first page render', () => {
        expect(resolveEmbeddedShapeImportLoadPolicy(new Uint8Array([1]), null)).toEqual({
            awaitBeforeInitialRender: true,
            deferUntilAfterInitialRender: false,
        });
    });
});
