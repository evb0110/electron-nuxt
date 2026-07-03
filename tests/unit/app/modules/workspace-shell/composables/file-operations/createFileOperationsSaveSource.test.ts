import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { shallowRef } from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import {
    createFileOperationsSaveSource,
    type IFileOperationsSaveSourcePorts,
    type IFileOperationsSaveSourceServices,
} from '@app/modules/workspace-shell/composables/file-operations/createFileOperationsSaveSource';
import { cast } from '@tests/helpers/cast';

function createEditorFreeTextNote(): IAnnotationCommentSummary {
    return {
        id: 'editor:0:pdfjs_internal_editor_0',
        stableKey: 'uid:0:pdfjs_internal_editor_0',
        sortIndex: null,
        pageIndex: 0,
        pageNumber: 1,
        text: 'persist me',
        kindLabel: 'Note',
        subtype: 'FreeText',
        author: null,
        modifiedAt: null,
        color: null,
        uid: 'pdfjs_internal_editor_0',
        annotationId: null,
        source: 'editor',
        hasNote: true,
        markerRect: {
            left: 0.2,
            top: 0.2,
            width: 0.01,
            height: 0.01,
        },
    };
}

function createSource(overrides: {
    comments?: IAnnotationCommentSummary[];
    pdfDocument?: PDFDocumentProxy | null;
    saveDocument?: () => Promise<Uint8Array | null>;
    getSourcePdfData?: () => Promise<Uint8Array | null>;
} = {}) {
    const phases: string[] = [];
    const ports: IFileOperationsSaveSourcePorts = {pdf: {
        source: {
            pdfDocument: shallowRef(overrides.pdfDocument ?? null),
            runSaveTransaction: vi.fn(async () => ({
                source: 'pdfjs-materialize' as const,
                baseBytes: null,
                serializedBytes: await (overrides.saveDocument ?? (async () => new Uint8Array([7])))(),
                nativeMutationPlan: null,
                annotationSavePlan: null,
                annotationCommentsSnapshot: [],
                pendingEmbeddedTextUpdates: new Map(),
                pendingEmbeddedAnnotationDeletes: [],
                restoreConsumedPendingEmbeddedMutations: vi.fn(),
                commitConsumedPendingEmbeddedMutations: vi.fn(),
            })),
            saveDocument: vi.fn(overrides.saveDocument ?? (async () => new Uint8Array([7]))),
            getSourcePdfData: vi.fn(overrides.getSourcePdfData ?? (async () => new Uint8Array([9]))),
        },
        serialization: {serializePdfForSave: vi.fn(async data => data)},
    }};
    const services: IFileOperationsSaveSourceServices = {
        getAnnotationCommentsForSave: vi.fn(() => overrides.comments ?? []),
        logSavePhase: vi.fn(),
        nowMs: vi.fn(() => 10),
        timedSavePhase: async (phase, operation) => {
            phases.push(phase);
            return operation();
        },
    };

    return {
        phases,
        ports,
        saveSource: createFileOperationsSaveSource(ports, services),
        services,
    };
}

describe('createFileOperationsSaveSource', () => {
    it('selects source bytes for replayable editor-only note work covered by pending text', async () => {
        const pendingTexts = new Map([[
            'uid:0:pdfjs_internal_editor_0',
            'persist me',
        ]]);
        const pdfDocument = cast<PDFDocumentProxy>({ annotationStorage: {
            resetModified: vi.fn(),
            modifiedIds: { ids: new Set(['pdfjs_internal_editor_0']) },
        } });
        const {
            phases,
            ports,
            saveSource,
        } = createSource({
            comments: [createEditorFreeTextNote()],
            pdfDocument,
        });

        const bytes = await saveSource.getSerializationBasePdfBytes({pendingTexts});

        expect(Array.from(bytes ?? [])).toEqual([9]);
        expect(ports.pdf.source.saveDocument).not.toHaveBeenCalled();
        expect(ports.pdf.source.getSourcePdfData).toHaveBeenCalledOnce();
        expect(phases).toEqual(['read-source-pdf-bytes']);
    });

    it('materializes through PDF.js when live annotation storage has unreplayable changes', async () => {
        const pdfDocument = cast<PDFDocumentProxy>({ annotationStorage: {
            resetModified: vi.fn(),
            modifiedIds: { ids: new Set(['uncovered-live-id']) },
        } });
        const {
            ports,
            saveSource,
        } = createSource({pdfDocument});

        const bytes = await saveSource.getSerializationBasePdfBytes();

        expect(Array.from(bytes ?? [])).toEqual([7]);
        expect(ports.pdf.source.runSaveTransaction).toHaveBeenCalledWith({
            mode: 'pdfjs-materialize',
            forcePdfjsMaterialize: true,
        });
        expect(ports.pdf.source.saveDocument).not.toHaveBeenCalled();
        expect(ports.pdf.source.getSourcePdfData).not.toHaveBeenCalled();
    });
});
