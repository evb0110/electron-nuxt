import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TTranslateFn } from '@i18n-app';
import { createEpochGuard } from '@app/modules/workspace-shell/composables/document-session/createEpochGuard';
import { createDocumentOpenFlow } from '@app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow';
import { createDocumentSessionState } from '@app/modules/workspace-shell/composables/document-session/createDocumentSessionState';

const mocks = vi.hoisted(() => ({
    documentFiles: {
        readFile: vi.fn(),
        readFileRange: vi.fn(),
        statFile: vi.fn(),
        writeFile: vi.fn(),
    },
    documentMenu: { onOpenDocumentDirectBatchProgress: vi.fn(() => vi.fn()) },
    documentOpen: {
        openDocumentDirect: vi.fn(),
        openDocumentDirectBatch: vi.fn(),
    },
    documentPicker: { openDocumentDialog: vi.fn() },
    legacyDocuments: {
        statFile: vi.fn(async () => {
            throw new Error('legacy statFile should not be used');
        }),
        writeFile: vi.fn(async () => {
            throw new Error('legacy writeFile should not be used');
        }),
    },
}));

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentFilesCapability: () => mocks.documentFiles,
    getDocumentMenuCapability: () => mocks.documentMenu,
    getDocumentOpenCapability: () => mocks.documentOpen,
    getDocumentPickerCapability: () => mocks.documentPicker,
    getDocumentsCapability: () => mocks.legacyDocuments,
}));

const PDF_BYTES = Uint8Array.from([
    37,
    80,
    68,
    70,
]);

function createOpenFlowHarness() {
    const state = createDocumentSessionState({ isDesktopRuntime: ref(true) });
    const deps = {
        analytics: {
            clearDocumentContext: vi.fn(),
            enabled: false,
            flush: vi.fn(async () => undefined),
            installLifecycle: vi.fn(),
            mergeDocumentContext: vi.fn(),
            setDocumentContext: vi.fn(),
            track: vi.fn(),
        },
        clearPdfConformanceProfile: vi.fn(),
        cleanupPreviousWorkingCopy: vi.fn(async () => undefined),
        deferPdfConformanceProfile: vi.fn(),
        incrementSessionVersion: vi.fn(),
        loadEpoch: createEpochGuard(),
        openEpoch: createEpochGuard(),
        pushHistorySnapshot: vi.fn(async () => true),
        resetHistory: vi.fn(async () => undefined),
        syncDirtyFromHistory: vi.fn(),
        t: ((key: string) => key) as TTranslateFn,
    };

    return {
        deps,
        openFlow: createDocumentOpenFlow(state, deps),
        state,
    };
}

describe('createDocumentOpenFlow', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.documentFiles.statFile.mockResolvedValue({ size: PDF_BYTES.byteLength });
        mocks.documentFiles.readFile.mockResolvedValue(PDF_BYTES);
        mocks.documentFiles.readFileRange.mockResolvedValue(new Uint8Array());
        mocks.documentFiles.writeFile.mockResolvedValue(true);
    });

    it('reads PDF state with the split document files stat capability', async () => {
        const { openFlow } = createOpenFlowHarness();

        const nextState = await openFlow.readPdfStateFromPath('/tmp/work.pdf');

        expect(nextState.pdfData).toEqual(PDF_BYTES);
        expect(mocks.documentFiles.statFile).toHaveBeenCalledWith('/tmp/work.pdf');
        expect(mocks.documentFiles.readFile).toHaveBeenCalledWith('/tmp/work.pdf');
        expect(mocks.legacyDocuments.statFile).not.toHaveBeenCalled();
    });

    it('persists in-memory PDF snapshots with the split document files write capability', async () => {
        const {
            openFlow,
            state,
        } = createOpenFlowHarness();
        state.workingCopyPath.value = '/tmp/work.pdf';
        const snapshot = Uint8Array.from([
            37,
            80,
            68,
            70,
            45,
        ]);

        await openFlow.loadPdfFromData(snapshot, { persistWorkingCopy: true });

        expect(mocks.documentFiles.writeFile).toHaveBeenCalledWith('/tmp/work.pdf', snapshot);
        expect(mocks.legacyDocuments.writeFile).not.toHaveBeenCalled();
    });

    it('tracks preselected opens with the split document files stat capability', async () => {
        mocks.documentFiles.statFile.mockResolvedValueOnce({ size: 2 * 1024 * 1024 });
        const {
            deps,
            openFlow,
            state,
        } = createOpenFlowHarness();
        const preselectedDjvu: TOpenFileResult = {
            kind: 'djvu',
            originalPath: '/tmp/scan.djvu',
            workingPath: '',
        };

        const outcome = await openFlow.openFile(preselectedDjvu);

        expect(outcome.status).toBe('opened');
        expect(state.pendingDjvu.value).toBe('/tmp/scan.djvu');
        expect(mocks.documentFiles.statFile).toHaveBeenCalledWith('/tmp/scan.djvu');
        expect(mocks.legacyDocuments.statFile).not.toHaveBeenCalled();
        expect(deps.analytics.track).toHaveBeenCalledWith('document_opened', expect.objectContaining({
            documentKind: 'djvu',
            fileExtension: 'djvu',
            fileSizeBucket: '1mb_to_10mb',
            openMethod: 'preselected',
            requiresSaveAsOnFirstSave: false,
        }));
    });
});
