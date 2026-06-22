import {
    describe,
    expect,
    it,
} from 'vitest';
import { embeddedShapeImportInitialRenderMaxBytes } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-import-policy/embeddedShapeImportInitialRenderMaxBytes';
import { resolveEmbeddedShapeImportLoadPolicy } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-import-policy/resolveEmbeddedShapeImportLoadPolicy';

describe('resolveEmbeddedShapeImportLoadPolicy', () => {
    it('awaits path-backed embedded drawings before the first page render when size is unknown', () => {
        expect(resolveEmbeddedShapeImportLoadPolicy(null, '/tmp/book.pdf')).toEqual({
            awaitBeforeInitialRender: true,
            deferUntilAfterInitialRender: false,
        });
    });

    it('awaits small path-backed embedded drawings before the first page render', () => {
        expect(resolveEmbeddedShapeImportLoadPolicy(null, '/tmp/book.pdf', 1024)).toEqual({
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

    it('defers byte-backed embedded drawing imports above the in-memory threshold', () => {
        expect(resolveEmbeddedShapeImportLoadPolicy(
            new Uint8Array(embeddedShapeImportInitialRenderMaxBytes + 1),
            '/tmp/large-book.pdf',
        )).toEqual({
            awaitBeforeInitialRender: false,
            deferUntilAfterInitialRender: true,
        });
    });

    it('skips automatic path-backed embedded drawing imports above the in-memory threshold', () => {
        expect(resolveEmbeddedShapeImportLoadPolicy(
            null,
            '/tmp/large-book.pdf',
            embeddedShapeImportInitialRenderMaxBytes + 1,
        )).toEqual({
            awaitBeforeInitialRender: false,
            deferUntilAfterInitialRender: false,
            skipAutomaticImport: true,
        });
    });
});
