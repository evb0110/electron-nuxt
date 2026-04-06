import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveEmbeddedShapeImportLoadPolicy } from '@app/composables/pdf/pdfEmbeddedShapeImportPolicy';

describe('resolveEmbeddedShapeImportLoadPolicy', () => {
    it('awaits shape import before initial render when PDF bytes are already in memory', () => {
        expect(resolveEmbeddedShapeImportLoadPolicy(
            new Uint8Array([
                1,
                2,
                3,
            ]),
            '/tmp/example.pdf',
        )).toEqual({
            awaitBeforeInitialRender: true,
            deferUntilAfterInitialRender: false,
        });
    });

    it('defers shape import for path-backed PDFs without in-memory bytes', () => {
        expect(resolveEmbeddedShapeImportLoadPolicy(
            null,
            '/tmp/example.pdf',
        )).toEqual({
            awaitBeforeInitialRender: false,
            deferUntilAfterInitialRender: true,
        });
    });

    it('does not defer cleanup-only transitions without a working path', () => {
        expect(resolveEmbeddedShapeImportLoadPolicy(
            null,
            null,
        )).toEqual({
            awaitBeforeInitialRender: true,
            deferUntilAfterInitialRender: false,
        });
    });
});
