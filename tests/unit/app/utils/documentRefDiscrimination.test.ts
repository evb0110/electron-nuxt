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
} from '@contracts/documentRef';
import {
    isBrowserDocumentRef,
    isNativeDocumentRef,
    resolveDocumentRefBackend,
} from '@app/utils/documentRef';

describe('documentRef discrimination', () => {
    it('distinguishes browser refs from native absolute paths', () => {
        expect(isBrowserDocumentRef('browser://documents/source-1')).toBe(true);
        expect(isNativeDocumentRef('browser://documents/source-1')).toBe(false);
        expect(resolveDocumentRefBackend('browser://documents/source-1')).toBe('browser');

        expect(isNativeDocumentRef('/Users/example/document.pdf')).toBe(true);
        expect(isBrowserDocumentRef('/Users/example/document.pdf')).toBe(false);
        expect(resolveDocumentRefBackend('/Users/example/document.pdf')).toBe('electron');

        expect(inferDocumentRefBackend('relative/document.pdf')).toBe('unknown');
        expect(resolveDocumentRefBackend('relative/document.pdf')).toBeUndefined();
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
