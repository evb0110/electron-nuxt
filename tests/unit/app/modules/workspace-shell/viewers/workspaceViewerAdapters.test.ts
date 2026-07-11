import {
    describe,
    expect,
    it,
} from 'vitest';
import { WORKSPACE_DOCUMENT_EXTENSIONS } from '@app/utils/supportedDocumentPaths';
import {
    WORKSPACE_VIEWER_ADAPTERS,
    getWorkspaceViewerAdapter,
    getWorkspaceViewerCapabilitiesForDocumentType,
    resolveWorkspaceViewerAdapter,
} from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import type {
    IWorkspaceViewerAdapter,
    TWorkspaceViewerDocumentType,
} from '@app/modules/workspace-shell/viewers/workspaceViewerAdapterTypes';

function getDocumentTypeForExtension(extension: string): TWorkspaceViewerDocumentType | null {
    if (extension === '.pdf') {
        return 'pdf';
    }

    if (extension === '.djvu' || extension === '.djv') {
        return 'djvu';
    }

    if ([
        '.png',
        '.jpg',
        '.jpeg',
        '.tif',
        '.tiff',
        '.bmp',
        '.webp',
        '.gif',
    ].includes(extension)) {
        return 'image';
    }

    return null;
}

describe('workspace viewer adapter registry', () => {
    it('covers every supported workspace document type', () => {
        const registeredTypes = new Set<TWorkspaceViewerDocumentType>(
            WORKSPACE_VIEWER_ADAPTERS.flatMap(adapter => [...adapter.documentTypes]),
        );

        for (const extension of WORKSPACE_DOCUMENT_EXTENSIONS) {
            const documentType = getDocumentTypeForExtension(extension);
            expect(documentType, extension).not.toBeNull();
            if (documentType) {
                expect(registeredTypes.has(documentType), extension).toBe(true);
            }
        }
    });

    it('keeps adapter capabilities aligned with current shell contracts', () => {
        const adapters = new Map<string, IWorkspaceViewerAdapter>(
            WORKSPACE_VIEWER_ADAPTERS.map(adapter => [
                adapter.id,
                adapter,
            ]),
        );

        expect(adapters.get('pdf')?.capabilities).toMatchObject({
            closeableDocument: true,
            conversionDialog: false,
            pdfMutationActions: true,
            repairSave: true,
            save: true,
            sidebar: true,
        });
        expect(adapters.get('native-pdf')?.capabilities).toMatchObject({
            closeableDocument: true,
            conversionDialog: false,
            pdfMutationActions: false,
            repairSave: false,
            save: false,
            sidebar: false,
        });
        expect(adapters.get('djvu')?.capabilities).toMatchObject({
            closeableDocument: true,
            conversionBanner: true,
            conversionDialog: true,
            pdfMutationActions: true,
            repairSave: false,
            save: false,
            saveAs: true,
            sidebar: true,
        });
    });

    it('reproduces PDF, native PDF, and DjVu viewer selection', () => {
        expect(resolveWorkspaceViewerAdapter({
            djvuSourcePath: null,
            isDjvuMode: false,
            pdfSourcePath: '/tmp/file.pdf',
            shouldUseNativePdf: false,
        })?.id).toBe('pdf');

        expect(resolveWorkspaceViewerAdapter({
            djvuSourcePath: null,
            isDjvuMode: false,
            pdfSourcePath: '/tmp/large.pdf',
            shouldUseNativePdf: true,
        })?.id).toBe('native-pdf');

        expect(resolveWorkspaceViewerAdapter({
            djvuSourcePath: '/tmp/file.djvu',
            isDjvuMode: true,
            pdfSourcePath: null,
            shouldUseNativePdf: false,
        })?.id).toBe('djvu');
    });

    it('exposes document-type capabilities and lifecycle hooks through adapters', () => {
        expect(getWorkspaceViewerCapabilitiesForDocumentType('djvu')).toMatchObject({
            closeableDocument: true,
            conversionDialog: true,
        });
        expect(getWorkspaceViewerCapabilitiesForDocumentType('pdf')).toBe(getWorkspaceViewerAdapter('pdf').capabilities);
        expect(getWorkspaceViewerCapabilitiesForDocumentType('image')).toBe(getWorkspaceViewerAdapter('pdf').capabilities);
        expect(getWorkspaceViewerAdapter('djvu').createLifecycleHooks).toBeTypeOf('function');
        expect(getWorkspaceViewerAdapter('pdf').createLifecycleHooks).toBeUndefined();
    });
});
