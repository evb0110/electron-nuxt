import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { createDocumentPersistence } from '@app/modules/workspace-shell/composables/document-session/createDocumentPersistence';
import { createDocumentSessionState } from '@app/modules/workspace-shell/composables/document-session/createDocumentSessionState';
import { requirePageIndex } from '@contracts/pageNumbers';
import type { TTranslateFn } from '@i18n-app';
import {requireDocumentRevisionToken} from '@contracts';

const TEST_DOCUMENT_REVISION_TOKEN = requireDocumentRevisionToken('drt1:test:persistence-base');

const mocks = vi.hoisted(() => {
    const createBroadFacadeTripwire = (method: string, capability = 'document files') => vi.fn(() => {
        throw new Error(`${method} should use the split ${capability} capability`);
    });

    return {
        documentFilesCapability: {
            applyPdfNativeMutationsToWorkingCopy: vi.fn(),
            commitStagedPdfNativeMutations: vi.fn(),
            optimizePdfAsCopy: vi.fn(),
            optimizePdfForInteraction: vi.fn(),
            repairPdf: vi.fn(),
            saveFileStructured: vi.fn(),
            savePdfAs: vi.fn(),
            savePdfNativeMutations: vi.fn(),
            savePdfNoteChanges: vi.fn(),
            savePdfNoteTextUpdates: vi.fn(),
            writeFile: vi.fn(),
        },
        documentWorkingCopyCapability: {
            cleanupFile: vi.fn(),
            createWorkingCopyFromPath: vi.fn(),
        },
        documentsCapability: {
            cleanupFile: createBroadFacadeTripwire('cleanupFile', 'document working-copy'),
            createWorkingCopyFromPath: createBroadFacadeTripwire('createWorkingCopyFromPath', 'document working-copy'),
            optimizePdfAsCopy: createBroadFacadeTripwire('optimizePdfAsCopy'),
            optimizePdfForInteraction: createBroadFacadeTripwire('optimizePdfForInteraction'),
            repairPdf: createBroadFacadeTripwire('repairPdf'),
            saveFileStructured: createBroadFacadeTripwire('saveFileStructured'),
            savePdfAs: createBroadFacadeTripwire('savePdfAs'),
            savePdfNativeMutations: createBroadFacadeTripwire('savePdfNativeMutations'),
            savePdfNoteChanges: createBroadFacadeTripwire('savePdfNoteChanges'),
            savePdfNoteTextUpdates: createBroadFacadeTripwire('savePdfNoteTextUpdates'),
            writeFile: createBroadFacadeTripwire('writeFile'),
        },
        savePdfBytesToWorkingCopy: vi.fn(),
        readDocumentBytes: vi.fn(),
        shouldRefreshWorkingCopyAfterSaveAs: vi.fn(),
    };
});

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentFilesCapability: () => mocks.documentFilesCapability,
    getDocumentWorkingCopyCapability: () => mocks.documentWorkingCopyCapability,
    getDocumentsCapability: () => mocks.documentsCapability,
    shouldRefreshWorkingCopyAfterSaveAs: mocks.shouldRefreshWorkingCopyAfterSaveAs,
}));
vi.mock('@app/services/pdf-file/savePdfBytesToWorkingCopy', () => ({savePdfBytesToWorkingCopy: mocks.savePdfBytesToWorkingCopy}));
vi.mock('@app/utils/documentBytes', () => ({readDocumentBytes: mocks.readDocumentBytes}));

function createPersistenceHarness() {
    const state = createDocumentSessionState({ isDesktopRuntime: ref(false) });
    state.workingCopyPath.value = '/tmp/old-working.pdf';
    state.originalPath.value = '/tmp/original.pdf';
    state.documentRevisionToken.value = TEST_DOCUMENT_REVISION_TOKEN;
    state.isDirty.value = true;

    const deps = {
        deferPdfConformanceProfile: vi.fn(),
        getHistoryDebugState: vi.fn(() => ({
            historyLength: 1,
            historyIndex: 0,
            historyCleanIndex: -1,
        })),
        markCurrentHistoryEntryClean: vi.fn(async () => undefined),
        pushHistorySnapshot: vi.fn(async () => true),
        readPdfStateFromPath: vi.fn(async () => ({
            pdfData: new Uint8Array([1]),
            pdfSrc: {
                kind: 'path' as const,
                path: '/tmp/new-working.pdf',
                size: 1,
            },
        })),
        shouldForceSaveAsForWorkingCopy: vi.fn(async () => false),
        t: ((key: string) => key) as TTranslateFn,
        toPdfBlob: vi.fn(() => new Blob()),
    };

    return {
        deps,
        persistence: createDocumentPersistence(state, deps),
        state,
    };
}

function expectBroadFilePersistenceFacadeNotUsed() {
    expect(mocks.documentsCapability.optimizePdfAsCopy).not.toHaveBeenCalled();
    expect(mocks.documentsCapability.optimizePdfForInteraction).not.toHaveBeenCalled();
    expect(mocks.documentsCapability.repairPdf).not.toHaveBeenCalled();
    expect(mocks.documentsCapability.saveFileStructured).not.toHaveBeenCalled();
    expect(mocks.documentsCapability.savePdfAs).not.toHaveBeenCalled();
    expect(mocks.documentsCapability.savePdfNativeMutations).not.toHaveBeenCalled();
    expect(mocks.documentsCapability.savePdfNoteChanges).not.toHaveBeenCalled();
    expect(mocks.documentsCapability.savePdfNoteTextUpdates).not.toHaveBeenCalled();
    expect(mocks.documentsCapability.writeFile).not.toHaveBeenCalled();
}

function expectBroadWorkingCopyFacadeNotUsed() {
    expect(mocks.documentsCapability.cleanupFile).not.toHaveBeenCalled();
    expect(mocks.documentsCapability.createWorkingCopyFromPath).not.toHaveBeenCalled();
}

describe('createDocumentPersistence', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        const validPdfResult = {
            isValid: true,
            tool: 'native' as const,
            errors: [],
            warnings: [],
        };
        Object.assign(mocks.documentFilesCapability, {
            applyPdfNativeMutationsToWorkingCopy: vi.fn(),
            commitStagedPdfNativeMutations: vi.fn(),
            savePdfNativeMutations: vi.fn(),
            savePdfNoteChanges: vi.fn(),
            savePdfNoteTextUpdates: vi.fn(),
        });
        mocks.documentFilesCapability.optimizePdfAsCopy.mockResolvedValue({
            path: '/tmp/optimized.pdf',
            validation: null,
            preset: 'lossless',
            originalBytes: 100,
            optimizedBytes: 90,
            pageCount: 1,
        });
        mocks.documentFilesCapability.optimizePdfForInteraction.mockResolvedValue(validPdfResult);
        mocks.documentFilesCapability.repairPdf.mockResolvedValue(validPdfResult);
        mocks.documentFilesCapability.saveFileStructured.mockResolvedValue({
            ok: true,
            externalWriteCommitted: true,
            workingCopyRefreshed: true,
            validation: null,
        });
        mocks.documentFilesCapability.savePdfAs.mockResolvedValue('/tmp/saved.pdf');
        mocks.documentFilesCapability.savePdfNativeMutations.mockResolvedValue({
            applied: true,
            validation: validPdfResult,
        });
        const stagedOutput = {
            path: '/tmp/staged-native.pdf',
            size: 3,
            sha256: 'a'.repeat(64),
            leaseId: 'staged-native-lease',
            revision: TEST_DOCUMENT_REVISION_TOKEN,
        };
        mocks.documentFilesCapability.applyPdfNativeMutationsToWorkingCopy.mockResolvedValue({
            applied: true,
            validation: validPdfResult,
            stagedOutput,
        });
        mocks.documentFilesCapability.commitStagedPdfNativeMutations.mockResolvedValue({
            applied: true,
            validation: validPdfResult,
        });
        mocks.readDocumentBytes.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        mocks.documentFilesCapability.savePdfNoteChanges.mockResolvedValue({
            applied: true,
            validation: validPdfResult,
        });
        mocks.documentFilesCapability.savePdfNoteTextUpdates.mockResolvedValue({
            applied: true,
            validation: validPdfResult,
        });
        mocks.documentFilesCapability.writeFile.mockResolvedValue(true);
        mocks.documentWorkingCopyCapability.cleanupFile.mockResolvedValue(undefined);
        mocks.documentWorkingCopyCapability.createWorkingCopyFromPath.mockResolvedValue('/tmp/new-working.pdf');
        mocks.savePdfBytesToWorkingCopy.mockResolvedValue({
            isValid: true,
            errors: [],
        });
        mocks.shouldRefreshWorkingCopyAfterSaveAs.mockReturnValue(true);
    });

    it('persists silent PDF data through the split file IO capability', async () => {
        const {
            deps,
            persistence,
            state,
        } = createPersistenceHarness();
        const data = new Uint8Array([
            7,
            8,
            9,
        ]);

        const result = await persistence.persistPdfDataSilently(data);

        expect(result).toBe(true);
        expect(mocks.documentFilesCapability.writeFile).toHaveBeenCalledWith('/tmp/old-working.pdf', new Uint8Array([
            7,
            8,
            9,
        ]), {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN});
        expect(mocks.documentFilesCapability.writeFile.mock.calls[0]?.[1]).not.toBe(data);
        expect(deps.pushHistorySnapshot).toHaveBeenCalledWith(new Uint8Array([
            7,
            8,
            9,
        ]), { reuseSnapshot: true });
        expect(state.pdfData.value).toEqual(new Uint8Array([
            7,
            8,
            9,
        ]));
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('saves the working copy through the split file IO capability', async () => {
        const { persistence } = createPersistenceHarness();

        const result = await persistence.saveWorkingCopy();

        expect(result.success).toBe(true);
        expect(mocks.documentFilesCapability.saveFileStructured).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('keeps the working copy dirty when a browser save is canceled', async () => {
        const {
            deps,
            persistence,
            state,
        } = createPersistenceHarness();
        mocks.documentFilesCapability.saveFileStructured.mockResolvedValueOnce({
            ok: false,
            reason: 'user-canceled',
            externalWriteCommitted: false,
            validation: null,
        });

        const result = await persistence.saveWorkingCopy();

        expect(result.success).toBe(false);
        expect(state.isDirty.value).toBe(true);
        expect(deps.markCurrentHistoryEntryClean).not.toHaveBeenCalled();
        expect(mocks.documentFilesCapability.saveFileStructured).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('repairs the working copy through the split file IO capability', async () => {
        const { persistence } = createPersistenceHarness();

        const result = await persistence.repairWorkingCopy();

        expect(result.success).toBe(true);
        expect(mocks.documentFilesCapability.repairPdf).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('optimizes the working copy through the split file IO capability', async () => {
        const { persistence } = createPersistenceHarness();

        const result = await persistence.optimizeWorkingCopy();

        expect(result.success).toBe(true);
        expect(mocks.documentFilesCapability.optimizePdfForInteraction).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('optimizes a working-copy copy through the split file IO capability', async () => {
        const {
            persistence,
            state,
        } = createPersistenceHarness();
        const options = { preset: 'lossless' as const };

        const result = await persistence.optimizeWorkingCopyAsCopy(options, 'optimize-1');

        expect(result.success).toBe(true);
        expect(result.outPath).toBe('/tmp/optimized.pdf');
        expect(state.originalPath.value).toBe('/tmp/optimized.pdf');
        expect(mocks.documentFilesCapability.optimizePdfAsCopy).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            options,
            'optimize-1',
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(mocks.documentWorkingCopyCapability.createWorkingCopyFromPath).toHaveBeenCalledWith('/tmp/optimized.pdf');
        expect(mocks.documentWorkingCopyCapability.cleanupFile).toHaveBeenCalledWith('/tmp/old-working.pdf');
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('cleans a stale optimized-copy working copy through the split working-copy capability', async () => {
        const {
            persistence,
            state,
        } = createPersistenceHarness();
        mocks.documentWorkingCopyCapability.createWorkingCopyFromPath.mockImplementationOnce(async () => {
            state.workingCopyPath.value = '/tmp/replaced-working.pdf';
            return '/tmp/new-working.pdf';
        });

        const result = await persistence.optimizeWorkingCopyAsCopy({ preset: 'lossless' }, 'optimize-stale');

        expect(result.success).toBe(false);
        expect(state.originalPath.value).toBe('/tmp/original.pdf');
        expect(state.workingCopyPath.value).toBe('/tmp/replaced-working.pdf');
        expect(mocks.documentFilesCapability.optimizePdfAsCopy).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            { preset: 'lossless' },
            'optimize-stale',
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(mocks.documentWorkingCopyCapability.createWorkingCopyFromPath).toHaveBeenCalledWith('/tmp/optimized.pdf');
        expect(mocks.documentWorkingCopyCapability.cleanupFile).toHaveBeenCalledWith('/tmp/new-working.pdf');
        expect(mocks.documentWorkingCopyCapability.cleanupFile).toHaveBeenCalledTimes(1);
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('keeps Save As successful when old working-copy cleanup fails', async () => {
        const {
            persistence,
            state,
        } = createPersistenceHarness();
        mocks.documentWorkingCopyCapability.cleanupFile.mockRejectedValueOnce(new Error('cleanup failed'));

        const result = await persistence.saveWorkingCopyAs();

        expect(result.success).toBe(true);
        expect(result.outPath).toBe('/tmp/saved.pdf');
        expect(state.originalPath.value).toBe('/tmp/saved.pdf');
        expect(state.workingCopyPath.value).toBe('/tmp/new-working.pdf');
        expect(mocks.documentFilesCapability.savePdfAs).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            undefined,
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(mocks.documentWorkingCopyCapability.createWorkingCopyFromPath).toHaveBeenCalledWith('/tmp/saved.pdf');
        expect(mocks.documentWorkingCopyCapability.cleanupFile).toHaveBeenCalledWith('/tmp/old-working.pdf');
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('cleans a stale Save As working copy through the split working-copy capability', async () => {
        const {
            persistence,
            state,
        } = createPersistenceHarness();
        mocks.documentWorkingCopyCapability.createWorkingCopyFromPath.mockImplementationOnce(async () => {
            state.workingCopyPath.value = '/tmp/replaced-working.pdf';
            return '/tmp/new-working.pdf';
        });

        const result = await persistence.saveWorkingCopyAs();

        expect(result.success).toBe(false);
        expect(state.originalPath.value).toBe('/tmp/original.pdf');
        expect(state.workingCopyPath.value).toBe('/tmp/replaced-working.pdf');
        expect(mocks.documentFilesCapability.savePdfAs).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            undefined,
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(mocks.documentWorkingCopyCapability.createWorkingCopyFromPath).toHaveBeenCalledWith('/tmp/saved.pdf');
        expect(mocks.documentWorkingCopyCapability.cleanupFile).toHaveBeenCalledWith('/tmp/new-working.pdf');
        expect(mocks.documentWorkingCopyCapability.cleanupFile).toHaveBeenCalledTimes(1);
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('saves generic native mutations through the split file IO capability', async () => {
        const { persistence } = createPersistenceHarness();
        const updates = [{
            objectNumber: 10,
            generationNumber: 0,
            text: 'Updated note text',
        }];
        const mutations = { updates };

        const result = await persistence.trySavePdfNativeMutations(mutations, {
            saveMode: 'rewrite',
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123456+03\'00\'',
        });

        expect(result?.success).toBe(true);
        expect(mocks.documentFilesCapability.applyPdfNativeMutationsToWorkingCopy).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            mutations,
            'D:20260628123456+03\'00\'',
            expect.objectContaining({byteLength: 3}),
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(mocks.documentFilesCapability.commitStagedPdfNativeMutations).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            expect.objectContaining({leaseId: 'staged-native-lease'}),
            {
                expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN,
                changedObjectRefs: ['10 0 R'],
            },
        );
        expect(mocks.documentFilesCapability.savePdfNativeMutations).not.toHaveBeenCalled();
        expect(mocks.documentFilesCapability.savePdfNoteChanges).not.toHaveBeenCalled();
        expect(mocks.documentFilesCapability.savePdfNoteTextUpdates).not.toHaveBeenCalled();
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('prefers generic native mutations over legacy note-change saves', async () => {
        const { persistence } = createPersistenceHarness();
        const freeTextNotes = [{
            pageIndex: requirePageIndex(0),
            stableKey: 'ann:0:generic-free-text-1',
            text: 'Generic free text note',
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.4,
            },
        }];
        const mutations = { freeTextNotes };

        const result = await persistence.trySavePdfNativeMutations(mutations, {
            saveMode: 'rewrite',
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123526+03\'00\'',
        });

        expect(result?.success).toBe(true);
        expect(mocks.documentFilesCapability.applyPdfNativeMutationsToWorkingCopy).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            mutations,
            'D:20260628123526+03\'00\'',
            expect.objectContaining({byteLength: 3}),
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(mocks.documentFilesCapability.commitStagedPdfNativeMutations).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            expect.objectContaining({leaseId: 'staged-native-lease'}),
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(mocks.documentFilesCapability.savePdfNativeMutations).not.toHaveBeenCalled();
        expect(mocks.documentFilesCapability.savePdfNoteChanges).not.toHaveBeenCalled();
        expect(mocks.documentFilesCapability.savePdfNoteTextUpdates).not.toHaveBeenCalled();
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('falls back to legacy note-text native saves through the split file IO capability', async () => {
        const { persistence } = createPersistenceHarness();
        const updates = [{
            objectNumber: 11,
            generationNumber: 0,
            text: 'Legacy text update',
        }];
        Object.assign(mocks.documentFilesCapability, {
            applyPdfNativeMutationsToWorkingCopy: undefined,
            commitStagedPdfNativeMutations: undefined,
            savePdfNativeMutations: undefined,
        });

        const result = await persistence.trySavePdfNativeMutations({ updates }, {
            saveMode: 'incremental',
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123556+03\'00\'',
        });

        expect(result?.success).toBe(true);
        expect(mocks.documentFilesCapability.savePdfNoteTextUpdates).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            updates,
            'D:20260628123556+03\'00\'',
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(mocks.documentFilesCapability.savePdfNoteChanges).not.toHaveBeenCalled();
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('falls back to legacy note-change native saves through the split file IO capability', async () => {
        const { persistence } = createPersistenceHarness();
        const freeTextNotes = [{
            pageIndex: requirePageIndex(0),
            stableKey: 'ann:0:free-text-1',
            text: 'Free text note',
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.4,
            },
        }];
        const deletes = [{
            pageIndex: requirePageIndex(1),
            objectNumber: 12,
            generationNumber: 0,
        }];
        Object.assign(mocks.documentFilesCapability, {
            applyPdfNativeMutationsToWorkingCopy: undefined,
            commitStagedPdfNativeMutations: undefined,
            savePdfNativeMutations: undefined,
        });

        const result = await persistence.trySavePdfNativeMutations({
            freeTextNotes,
            deletes,
        }, {
            saveMode: 'incremental',
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123626+03\'00\'',
        });

        expect(result?.success).toBe(true);
        expect(mocks.documentFilesCapability.savePdfNoteChanges).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            {
                freeTextNotes,
                deletes,
            },
            'D:20260628123626+03\'00\'',
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(mocks.documentFilesCapability.savePdfNoteTextUpdates).not.toHaveBeenCalled();
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('returns null for native mutations when no split native save method is available', async () => {
        const {
            deps,
            persistence,
        } = createPersistenceHarness();
        Object.assign(mocks.documentFilesCapability, {
            applyPdfNativeMutationsToWorkingCopy: undefined,
            commitStagedPdfNativeMutations: undefined,
            savePdfNativeMutations: undefined,
            savePdfNoteChanges: undefined,
            savePdfNoteTextUpdates: undefined,
        });
        const updates = [{
            objectNumber: 12,
            generationNumber: 0,
            text: 'No native route',
        }];

        const result = await persistence.trySavePdfNativeMutations({ updates }, {
            saveMode: 'rewrite',
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123656+03\'00\'',
        });

        expect(result).toBeNull();
        expect(deps.shouldForceSaveAsForWorkingCopy).not.toHaveBeenCalled();
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('records a fresh reload source without replacing the visible source when preserving the live session', async () => {
        const {
            persistence,
            state,
        } = createPersistenceHarness();
        state.pdfSrc.value = {
            kind: 'path',
            path: '/tmp/old-working.pdf',
            size: 1,
        };

        const result = await persistence.saveFile(new Uint8Array([
            1,
            2,
            3,
        ]), { preserveLoadedSource: true });

        expect(result.success).toBe(true);
        expect(state.pdfSrc.value).toEqual({
            kind: 'path',
            path: '/tmp/old-working.pdf',
            size: 1,
        });
        expect(state.pdfReloadSrc.value).toEqual({
            kind: 'path',
            path: '/tmp/old-working.pdf',
            size: 3,
        });
        expect(state.pdfData.value).toEqual(new Uint8Array([
            1,
            2,
            3,
        ]));
    });
});
