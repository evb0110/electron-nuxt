import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createBrowserDocumentRefValue,
    createNativeDocumentRefValue,
    inferDocumentRefBackend,
    isBrowserStructuredDocumentRef,
    isNativeStructuredDocumentRef,
    requireDocumentRef,
} from '@contracts/documentRef';
import {
    isBrowserDocumentRef,
    isNativeDocumentRef,
    resolveDocumentRefBackend,
} from '@app/utils/documentRef';
import type {TDocumentRef} from '@contracts/documentRef';

function isDocumentRefFixture(value: unknown): value is TDocumentRef {
    // Legacy document refs are branded strings, so the brand has no runtime
    // marker. Keep the malformed relative value at the boundary intentionally.
    return typeof value === 'string';
}

describe('documentRef discrimination', () => {
    it('distinguishes browser refs from native absolute paths', () => {
        expect(isBrowserDocumentRef(requireDocumentRef('browser://documents/source-1'))).toBe(true);
        expect(isNativeDocumentRef(requireDocumentRef('browser://documents/source-1'))).toBe(false);
        expect(resolveDocumentRefBackend(requireDocumentRef('browser://documents/source-1'))).toBe('browser');

        expect(isNativeDocumentRef(requireDocumentRef('/Users/example/document.pdf'))).toBe(true);
        expect(isBrowserDocumentRef(requireDocumentRef('/Users/example/document.pdf'))).toBe(false);
        expect(resolveDocumentRefBackend(requireDocumentRef('/Users/example/document.pdf'))).toBe('electron');

        const relativeRef: unknown = 'relative/document.pdf';
        if (!isDocumentRefFixture(relativeRef)) {
            throw new TypeError('Invalid document reference fixture');
        }
        expect(inferDocumentRefBackend(relativeRef)).toBe('unknown');
        expect(resolveDocumentRefBackend(relativeRef)).toBeUndefined();
    });

    it('brands structured browser and native refs with backend identity', () => {
        const browserRef = createBrowserDocumentRefValue('browser://documents/source-2');
        const nativeRef = createNativeDocumentRefValue('/Users/example/native.pdf');

        expect(isBrowserStructuredDocumentRef(browserRef)).toBe(true);
        expect(browserRef.backend).toBe('browser');
        expect(isNativeStructuredDocumentRef(nativeRef)).toBe(true);
        expect(nativeRef.backend).toBe('electron');
    });
});
