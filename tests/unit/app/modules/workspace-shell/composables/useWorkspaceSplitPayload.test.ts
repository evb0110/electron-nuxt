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

const mocks = vi.hoisted(() => ({
    createWorkingCopyFromPath: vi.fn(),
    createWorkingCopyFromData: vi.fn(),
    legacyCreateWorkingCopyFromPath: vi.fn(),
    legacyCreateWorkingCopyFromData: vi.fn(),
    legacyCleanupFile: vi.fn(),
    readDocumentBytes: vi.fn(),
}));

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentWorkingCopyCapability: () => ({
        createWorkingCopyFromPath: mocks.createWorkingCopyFromPath,
        createWorkingCopyFromData: mocks.createWorkingCopyFromData,
    }),
    getDocumentsCapability: () => ({
        createWorkingCopyFromPath: mocks.legacyCreateWorkingCopyFromPath,
        createWorkingCopyFromData: mocks.legacyCreateWorkingCopyFromData,
        cleanupFile: mocks.legacyCleanupFile,
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
});
