import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { TPdfSource } from '@app/types/pdfUi';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import { useWorkspaceSplitPayload } from '@app/modules/workspace-shell/composables/useWorkspaceSplitPayload';
import { IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES } from '@contracts/electronApiDocuments';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import {TEST_PDF_SAVE_BYTE_ROUTE_DECISION} from '@tests/unit/app/modules/pdf-viewer/runtime/save/testPdfSaveByteRouteDecision';

const mocks = vi.hoisted(() => ({
    createWorkingCopyFromPath: vi.fn(),
    createWorkingCopyFromData: vi.fn(),
    cleanupFile: vi.fn(),
    getDocumentRevision: vi.fn(),
    savePdfData: vi.fn(),
    legacyCreateWorkingCopyFromPath: vi.fn(),
    legacyCreateWorkingCopyFromData: vi.fn(),
    legacyCleanupFile: vi.fn(),
    readDocumentBytes: vi.fn(),
}));

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentWorkingCopyCapability: () => ({
        cleanupFile: mocks.cleanupFile,
        createWorkingCopyFromPath: mocks.createWorkingCopyFromPath,
        createWorkingCopyFromData: mocks.createWorkingCopyFromData,
    }),
    getDocumentFilesCapability: () => ({
        getDocumentRevision: mocks.getDocumentRevision,
        savePdfData: mocks.savePdfData,
    }),
}));

vi.mock('@app/utils/documentBytes', () => ({ readDocumentBytes: mocks.readDocumentBytes }));

type TUseWorkspaceSplitPayloadOptions = Parameters<typeof useWorkspaceSplitPayload>[0];

function pathPdfSource(path = '/tmp/working.pdf'): TPdfSource {
    return {
        kind: 'path',
        path,
        size: 1024,
    };
}

function installLegacyThrowingMocks() {
    mocks.legacyCreateWorkingCopyFromPath.mockImplementation(() => {
        throw new Error('legacy createWorkingCopyFromPath should not be used');
    });
    mocks.legacyCreateWorkingCopyFromData.mockImplementation(() => {
        throw new Error('legacy createWorkingCopyFromData should not be used');
    });
    mocks.legacyCleanupFile.mockImplementation(() => {
        throw new Error('legacy cleanupFile should not be used');
    });
}

function createOptions(
    overrides: Partial<TUseWorkspaceSplitPayloadOptions> = {},
): TUseWorkspaceSplitPayloadOptions {
    const options: TUseWorkspaceSplitPayloadOptions = {
        pdfSrc: ref<TPdfSource | null>(pathPdfSource()),
        isDjvuMode: ref(false),
        djvuSourcePath: ref(null),
        currentPage: ref(2),
        totalPages: ref(5),
        fileName: ref('sample.pdf'),
        originalPath: ref('/tmp/original.pdf'),
        workingCopyPath: ref('/tmp/working.pdf'),
        hasPendingTabChanges: ref(false),
        pdfViewerRef: ref(null),
        documentViewerRef: ref(null),
        pdfData: ref<Uint8Array | null>(null),
        openFileWithViewerLifecycle: vi.fn(async (): Promise<TDocumentOpenOutcome> => ({ status: 'cancelled' })),
        waitForPdfReload: vi.fn(async () => {}),
        loadPdfFromPath: vi.fn(async () => {}),
    };

    return {
        ...options,
        ...overrides,
    };
}

describe('useWorkspaceSplitPayload', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createWorkingCopyFromPath.mockResolvedValue('/tmp/split-path.pdf');
        mocks.createWorkingCopyFromData.mockResolvedValue('/tmp/split-data.pdf');
        mocks.cleanupFile.mockResolvedValue(undefined);
        mocks.getDocumentRevision.mockResolvedValue({
            version: 1,
            documentRef: '/tmp/split-path.pdf',
            authority: 'electron-working-copy',
            token: requireDocumentRevisionToken('split-revision'),
            contentRevision: 1,
            mintedAt: 1,
        });
        mocks.savePdfData.mockResolvedValue({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
        mocks.readDocumentBytes.mockResolvedValue(new Uint8Array([9]));
        installLegacyThrowingMocks();
    });

    it('uses the split working copy capability for clean working copy snapshots', async () => {
        const { captureSplitPayload } = useWorkspaceSplitPayload(createOptions());

        const payload = await captureSplitPayload();

        expect(payload).toEqual({
            kind: 'pdfSnapshot',
            fileName: 'sample.pdf',
            originalPath: '/tmp/original.pdf',
            originalBackend: 'electron',
            snapshotPath: '/tmp/split-path.pdf',
            snapshotBackend: 'electron',
            isDirty: false,
            currentPage: 2,
            totalPages: 5,
        });
        expect(mocks.createWorkingCopyFromPath).toHaveBeenCalledWith('/tmp/working.pdf', '/tmp/original.pdf');
        expect(mocks.createWorkingCopyFromData).not.toHaveBeenCalled();
        expect(mocks.readDocumentBytes).not.toHaveBeenCalled();
        expect(mocks.legacyCreateWorkingCopyFromPath).not.toHaveBeenCalled();
        expect(mocks.legacyCreateWorkingCopyFromData).not.toHaveBeenCalled();
    });

    it('uses the split working copy capability when staging dirty snapshot data', async () => {
        const pdfBytes = new Uint8Array([
            1,
            2,
            3,
        ]);
        const { captureSplitPayload } = useWorkspaceSplitPayload(createOptions({
            hasPendingTabChanges: ref(true),
            pdfData: ref(pdfBytes),
        }));

        const payload = await captureSplitPayload();

        expect(payload).toEqual({
            kind: 'pdfSnapshot',
            fileName: 'sample.pdf',
            originalPath: '/tmp/original.pdf',
            originalBackend: 'electron',
            snapshotPath: '/tmp/split-data.pdf',
            snapshotBackend: 'electron',
            isDirty: true,
            currentPage: 2,
            totalPages: 5,
        });
        expect(mocks.createWorkingCopyFromData).toHaveBeenCalledWith(
            'sample.pdf',
            pdfBytes,
            '/tmp/original.pdf',
        );
        expect(mocks.createWorkingCopyFromPath).not.toHaveBeenCalled();
        expect(mocks.legacyCreateWorkingCopyFromPath).not.toHaveBeenCalled();
        expect(mocks.legacyCreateWorkingCopyFromData).not.toHaveBeenCalled();
    });

    it('stages a small in-memory split snapshot without a working source path', async () => {
        const pdfBytes = new Uint8Array([
            4,
            5,
            6,
        ]);
        const { captureSplitPayload } = useWorkspaceSplitPayload(createOptions({
            hasPendingTabChanges: ref(true),
            pdfData: ref(pdfBytes),
            workingCopyPath: ref(null),
        }));

        await expect(captureSplitPayload()).resolves.toMatchObject({
            kind: 'pdfSnapshot',
            snapshotPath: '/tmp/split-data.pdf',
            isDirty: true,
        });
        expect(mocks.createWorkingCopyFromData).toHaveBeenCalledWith(
            'sample.pdf',
            pdfBytes,
            '/tmp/original.pdf',
        );
        expect(mocks.createWorkingCopyFromPath).not.toHaveBeenCalled();
    });

    it('serializes dirty split snapshots inside the viewer canonical save transaction', async () => {
        const serializedBytes = Uint8Array.of(7, 8, 9);
        const serializePdfForSave = vi.fn(async () => serializedBytes);
        const runSaveTransaction = vi.fn(async (request) => {
            expect(request).toMatchObject({
                mode: 'snapshot',
                forcePdfjsMaterialize: true,
                serializeResult: true,
                includeManagedShapes: true,
                rewriteShapeState: true,
            });
            expect(request.source?.serializePdfForSave).toBe(serializePdfForSave);
            return {
                source: 'serialized-rewrite' as const,
                baseBytes: Uint8Array.of(1),
                serializedBytes,
                serializedResult: null,
                nativeMutationProjection: null,
                fallbackDecision: TEST_PDF_SAVE_BYTE_ROUTE_DECISION,
                annotationSavePlan: {
                    route: 'pdfjs-materialize' as const,
                    expectedCost: 'full-document' as const,
                    reason: 'no-live-pdfjs-annotation-work' as const,
                    unreplayableLiveAnnotationIds: [],
                },
            };
        });
        const { captureSplitPayload } = useWorkspaceSplitPayload(createOptions({
            hasPendingTabChanges: ref(true),
            pdfViewerRef: ref({
                runSaveTransaction,
                saveDocument: vi.fn(async () => null),
                materializePdfJsDocumentForInternalUse: vi.fn(async () => null),
            }),
            serializePdfForSave,
        }));

        await captureSplitPayload();

        expect(runSaveTransaction).toHaveBeenCalledTimes(1);
        expect(serializePdfForSave).not.toHaveBeenCalled();
        expect(mocks.createWorkingCopyFromData).toHaveBeenCalledWith(
            'sample.pdf',
            serializedBytes,
            '/tmp/original.pdf',
        );
    });

    it('streams oversized dirty snapshots into a cloned working copy', async () => {
        const pdfBytes = new Uint8Array(IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES + 1);
        const { captureSplitPayload } = useWorkspaceSplitPayload(createOptions({
            hasPendingTabChanges: ref(true),
            pdfData: ref(pdfBytes),
        }));

        await expect(captureSplitPayload()).resolves.toMatchObject({
            kind: 'pdfSnapshot',
            snapshotPath: '/tmp/split-path.pdf',
            isDirty: true,
        });
        expect(mocks.createWorkingCopyFromData).not.toHaveBeenCalled();
        expect(mocks.createWorkingCopyFromPath).toHaveBeenCalledWith(
            '/tmp/working.pdf',
            '/tmp/original.pdf',
        );
        const saveArgs = mocks.savePdfData.mock.calls[0]!;
        expect(saveArgs[0]).toBe('/tmp/split-path.pdf');
        expect(saveArgs[1]).toBe(pdfBytes);
        expect(saveArgs[2]).toEqual({
            expectedDocumentRevisionToken: requireDocumentRevisionToken('split-revision'),
            workingCopyOnly: true,
        });
    });
});
