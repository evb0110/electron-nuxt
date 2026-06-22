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
import type { TTranslateFn } from '@i18n-app';

const mocks = vi.hoisted(() => ({
    documentsCapability: {
        cleanupFile: vi.fn(),
        createWorkingCopyFromPath: vi.fn(),
        savePdfAs: vi.fn(),
    },
    savePdfBytesToWorkingCopy: vi.fn(),
    shouldRefreshWorkingCopyAfterSaveAs: vi.fn(),
}));

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentsCapability: () => mocks.documentsCapability,
    shouldRefreshWorkingCopyAfterSaveAs: mocks.shouldRefreshWorkingCopyAfterSaveAs,
}));
vi.mock('@app/services/pdf-file/savePdfBytesToWorkingCopy', () => ({savePdfBytesToWorkingCopy: mocks.savePdfBytesToWorkingCopy}));

function createPersistenceHarness() {
    const state = createDocumentSessionState({ isDesktopRuntime: ref(false) });
    state.workingCopyPath.value = '/tmp/old-working.pdf';
    state.originalPath.value = '/tmp/original.pdf';
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

describe('createDocumentPersistence', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.documentsCapability.cleanupFile.mockResolvedValue(undefined);
        mocks.documentsCapability.createWorkingCopyFromPath.mockResolvedValue('/tmp/new-working.pdf');
        mocks.documentsCapability.savePdfAs.mockResolvedValue('/tmp/saved.pdf');
        mocks.savePdfBytesToWorkingCopy.mockResolvedValue({
            isValid: true,
            errors: [],
        });
        mocks.shouldRefreshWorkingCopyAfterSaveAs.mockReturnValue(true);
    });

    it('keeps Save As successful when old working-copy cleanup fails', async () => {
        const {
            persistence,
            state,
        } = createPersistenceHarness();
        mocks.documentsCapability.cleanupFile.mockRejectedValueOnce(new Error('cleanup failed'));

        const result = await persistence.saveWorkingCopyAs();

        expect(result.success).toBe(true);
        expect(result.outPath).toBe('/tmp/saved.pdf');
        expect(state.originalPath.value).toBe('/tmp/saved.pdf');
        expect(state.workingCopyPath.value).toBe('/tmp/new-working.pdf');
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
