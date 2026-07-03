import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
} from 'vue';
import { usePageFileOperations } from '@app/modules/workspace-shell/composables/usePageFileOperations';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import type { TPdfSource } from '@app/types/pdfUi';
import { cast } from '@tests/helpers/cast';

const {
    mockHasElectronAPI,
    mockOpenCombineDialog,
    mockOpenFolderDialog,
    mockLegacyOpenCombineDialog,
    mockLegacyOpenFolderDialog,
    mockReadFileRange,
} = vi.hoisted(() => ({
    mockHasElectronAPI: vi.fn(() => true),
    mockOpenCombineDialog: vi.fn<() => Promise<TOpenFileResult | null>>(async () => null),
    mockOpenFolderDialog: vi.fn<() => Promise<TOpenFileResult | null>>(async () => null),
    mockLegacyOpenCombineDialog: vi.fn(() => {
        throw new Error('legacy combine picker should not be used');
    }),
    mockLegacyOpenFolderDialog: vi.fn(() => {
        throw new Error('legacy folder picker should not be used');
    }),
    mockReadFileRange: vi.fn(async (_path: string, _offset: number, _length: number) => new Uint8Array([0])),
}));

vi.mock('@app/utils/platform', () => ({hasElectronAPI: () => mockHasElectronAPI()}));
vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentFilesCapability: () => ({readFileRange: mockReadFileRange}),
    getDocumentPickerCapability: () => ({
        openCombineDialog: mockOpenCombineDialog,
        openFolderDialog: mockOpenFolderDialog,
    }),
    getDocumentsCapability: () => ({
        openCombineDialog: mockLegacyOpenCombineDialog,
        openFolderDialog: mockLegacyOpenFolderDialog,
    }),
}));

function openedOutcome(path = '/tmp/working.pdf'): TDocumentOpenOutcome {
    return {
        status: 'opened',
        result: {
            kind: 'pdf',
            originalPath: path,
            workingPath: path,
        },
    };
}

function createDeps(overrides: Partial<Parameters<typeof usePageFileOperations>[0]> = {}) {
    const annotationDirty = overrides.annotationDirty ?? ref(false);
    const isDirty = overrides.isDirty ?? ref(false);
    const pageLabelsDirty = overrides.pageLabelsDirty ?? ref(false);
    const bookmarksDirty = overrides.bookmarksDirty ?? ref(false);

    return cast<Parameters<typeof usePageFileOperations>[0]>({
        pdfSrc: ref<unknown>({}),
        hasDocument: ref(true),
        isAnySaving: ref(false),
        isHistoryBusy: ref(false),
        isExportingDocx: ref(false),
        isAnyAnnotationNoteSaving: ref(false),
        annotationNoteWindows: ref([]),
        hasPendingUnsavedChanges: computed(() => (
            annotationDirty.value
            || isDirty.value
            || pageLabelsDirty.value
            || bookmarksDirty.value
        )),
        annotationDirty,
        isDirty,
        pageLabelsDirty,
        bookmarksDirty,
        persistAllAnnotationNotes: vi.fn(async (_force: boolean) => true),
        handleSave: vi.fn(async () => {}),
        pickFileToOpen: vi.fn(async () => null),
        openFile: vi.fn(async () => openedOutcome()),
        openFileDirect: vi.fn(async (path: string) => openedOutcome(path)),
        openFileDirectBatch: vi.fn(async (_paths: string[]) => openedOutcome()),
        closeFile: vi.fn(async () => {}),
        closeAllDropdowns: vi.fn(),
        emitOpenInNewTab: vi.fn(),
        removeRecentFile: vi.fn(async () => {}),
        notifyMissingRecentFile: vi.fn(),
        ...overrides,
    });
}

describe('usePageFileOperations', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mockHasElectronAPI.mockReturnValue(true);
        mockOpenCombineDialog.mockReset();
        mockOpenCombineDialog.mockResolvedValue(null);
        mockOpenFolderDialog.mockReset();
        mockOpenFolderDialog.mockResolvedValue(null);
        mockLegacyOpenCombineDialog.mockClear();
        mockLegacyOpenFolderDialog.mockClear();
        mockReadFileRange.mockReset();
        mockReadFileRange.mockResolvedValue(new Uint8Array([0]));
    });

    it('persists unsaved changes before closing by default', async () => {
        const isDirty = ref(true);
        const deps = createDeps({
            isDirty,
            handleSave: vi.fn(async () => {
                isDirty.value = false;
            }),
        });
        const { handleCloseFileFromUi } = usePageFileOperations(deps);

        await handleCloseFileFromUi();

        expect(deps.handleSave).toHaveBeenCalledOnce();
        expect(deps.closeFile).toHaveBeenCalledOnce();
        expect(deps.closeAllDropdowns).toHaveBeenCalledOnce();
    });

    it('uses the supplied pending change predicate for persistence gating', async () => {
        const hasPendingUnsavedChanges = ref(true);
        const deps = createDeps({
            hasPendingUnsavedChanges: computed(() => hasPendingUnsavedChanges.value),
            handleSave: vi.fn(async () => {
                hasPendingUnsavedChanges.value = false;
            }),
        });
        const { handleCloseFileFromUi } = usePageFileOperations(deps);

        await handleCloseFileFromUi();

        expect(deps.handleSave).toHaveBeenCalledOnce();
        expect(deps.closeFile).toHaveBeenCalledOnce();
    });

    it('can close without persisting when persist is false', async () => {
        const deps = createDeps({ isDirty: ref(true) });
        const { handleCloseFileFromUi } = usePageFileOperations(deps);

        await handleCloseFileFromUi({ persist: false });

        expect(deps.handleSave).not.toHaveBeenCalled();
        expect(deps.closeFile).toHaveBeenCalledOnce();
        expect(deps.closeAllDropdowns).toHaveBeenCalledOnce();
    });

    it('handles save rejection deterministically before opening another file', async () => {
        const errorSpy = vi.spyOn(BrowserLogger, 'error').mockImplementation(() => {});
        const deps = createDeps({
            isDirty: ref(true),
            handleSave: vi.fn(async () => {
                throw new Error('disk full');
            }),
        });
        const { handleOpenFileFromUi } = usePageFileOperations(deps);

        await expect(handleOpenFileFromUi()).resolves.toBe(false);

        expect(deps.pickFileToOpen).not.toHaveBeenCalled();
        expect(deps.openFile).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(
            'recent-open',
            'Switch blocked: save before switch threw',
            { error: 'disk full' },
        );
    });

    it('preserves a detailed blocked outcome when persistence prevents opening', async () => {
        const deps = createDeps({
            isDirty: ref(true),
            handleSave: vi.fn(async () => {
                throw new Error('disk full');
            }),
        });
        const {
            handleOpenFileFromUiDetailed,
            lastOpenOutcome,
        } = usePageFileOperations(deps);

        await expect(handleOpenFileFromUiDetailed()).resolves.toEqual({
            status: 'blocked',
            reason: 'persistence-gate',
        });

        expect(lastOpenOutcome.value).toEqual({
            status: 'blocked',
            reason: 'persistence-gate',
        });
        expect(deps.pickFileToOpen).not.toHaveBeenCalled();
    });

    it('opens through openFile directly in browser mode', async () => {
        mockHasElectronAPI.mockReturnValue(false);
        const openResult = {
            kind: 'pdf' as const,
            originalPath: 'browser://documents/source/browser-open.pdf',
            workingPath: 'browser://documents/working/browser-open.pdf',
        };
        const deps = createDeps({pickFileToOpen: vi.fn(async () => openResult)});
        const { handleOpenFileFromUi } = usePageFileOperations(deps);

        await expect(handleOpenFileFromUi()).resolves.toBe(true);

        expect(deps.pickFileToOpen).toHaveBeenCalledOnce();
        expect(deps.openFile).toHaveBeenCalledWith(openResult);
        expect(deps.closeAllDropdowns).toHaveBeenCalledOnce();
    });

    it('returns failed direct opens immediately without retrying or closing dropdowns', async () => {
        const warnSpy = vi.spyOn(BrowserLogger, 'warn').mockImplementation(() => {});
        const deps = createDeps({
            pdfSrc: ref(null),
            openFileDirect: vi.fn(async () => ({
                status: 'failed' as const,
                error: 'not allowed',
            })),
        });
        const { handleOpenFileDirectWithPersist } = usePageFileOperations(deps);

        await expect(handleOpenFileDirectWithPersist('/tmp/blocked.pdf')).resolves.toBe(false);

        expect(deps.openFileDirect).toHaveBeenCalledOnce();
        expect(deps.closeAllDropdowns).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
            'recent-open',
            'Open path finished without an active document',
            {
                path: '/tmp/blocked.pdf',
                status: 'failed',
                error: 'not allowed',
            },
        );
    });

    it('preserves failed direct-open details for UI diagnostics', async () => {
        const deps = createDeps({
            pdfSrc: ref(null),
            openFileDirect: vi.fn(async () => ({
                status: 'failed' as const,
                error: 'not allowed',
            })),
        });
        const {
            handleOpenFileDirectWithPersistDetailed,
            lastOpenOutcome,
        } = usePageFileOperations(deps);

        const outcome = await handleOpenFileDirectWithPersistDetailed('/tmp/blocked.pdf');

        expect(outcome).toEqual({
            status: 'failed',
            error: 'not allowed',
        });
        expect(lastOpenOutcome.value).toEqual(outcome);
        expect(deps.closeAllDropdowns).not.toHaveBeenCalled();
    });

    it('retries one stale direct open when no document reached renderer state', async () => {
        const infoSpy = vi.spyOn(BrowserLogger, 'info').mockImplementation(() => {});
        const pdfSrc = ref<TPdfSource | null>(null);
        let openAttempt = 0;
        const openFileDirect = vi.fn(async (path: string) => {
            openAttempt += 1;
            if (openAttempt === 1) {
                return {
                    status: 'stale' as const,
                    result: {
                        kind: 'pdf' as const,
                        originalPath: path,
                        workingPath: '/tmp/stale-working.pdf',
                    },
                };
            }

            pdfSrc.value = {
                kind: 'path',
                path,
                size: 1,
            };
            return openedOutcome(path);
        });
        const deps = createDeps({
            pdfSrc,
            openFileDirect,
        });
        const { handleOpenFileDirectWithPersist } = usePageFileOperations(deps);

        await expect(handleOpenFileDirectWithPersist('/tmp/startup.pdf')).resolves.toBe(true);

        expect(openFileDirect).toHaveBeenCalledTimes(2);
        expect(openFileDirect).toHaveBeenNthCalledWith(1, '/tmp/startup.pdf');
        expect(openFileDirect).toHaveBeenNthCalledWith(2, '/tmp/startup.pdf');
        expect(deps.closeAllDropdowns).toHaveBeenCalledOnce();
        expect(infoSpy).toHaveBeenCalledWith(
            'recent-open',
            'Retrying stale direct open once before returning to empty state',
            { path: '/tmp/startup.pdf' },
        );
    });

    it('awaits the persistence gate before invoking the open picker', async () => {
        const callOrder: string[] = [];
        const isDirty = ref(true);
        const handleSave = vi.fn(async () => {
            callOrder.push('save');
            isDirty.value = false;
        });
        const pickFileToOpen = vi.fn(async () => {
            callOrder.push('pick');
            return null;
        });
        const deps = createDeps({
            isDirty,
            handleSave,
            pickFileToOpen,
        });
        const { handleOpenFileFromUi } = usePageFileOperations(deps);

        await handleOpenFileFromUi();

        expect(callOrder).toEqual([
            'save',
            'pick',
        ]);
    });

    it('returns early without closing dropdowns when the open picker is cancelled', async () => {
        const deps = createDeps({ pickFileToOpen: vi.fn(async () => null) });
        const { handleOpenFileFromUi } = usePageFileOperations(deps);

        await handleOpenFileFromUi();

        expect(deps.pickFileToOpen).toHaveBeenCalledOnce();
        expect(deps.openFile).not.toHaveBeenCalled();
        expect(deps.emitOpenInNewTab).not.toHaveBeenCalled();
        expect(deps.closeAllDropdowns).not.toHaveBeenCalled();
    });

    it('runs the full open flow and closes dropdowns after handling the result', async () => {
        const openResult = {
            kind: 'pdf' as const,
            originalPath: '/tmp/source.pdf',
            workingPath: '/tmp/working.pdf',
        };
        const deps = createDeps({ pickFileToOpen: vi.fn(async () => openResult) });
        const { handleOpenFileFromUi } = usePageFileOperations(deps);

        await handleOpenFileFromUi();

        expect(deps.openFile).toHaveBeenCalledWith(openResult);
        expect(deps.emitOpenInNewTab).not.toHaveBeenCalled();
        expect(deps.closeAllDropdowns).toHaveBeenCalledOnce();
    });

    it('returns early without closing dropdowns when combine picker is cancelled', async () => {
        mockOpenCombineDialog.mockResolvedValue(null);
        const deps = createDeps();
        const { handleCombineImages } = usePageFileOperations(deps);

        await handleCombineImages();

        expect(mockOpenCombineDialog).toHaveBeenCalledOnce();
        expect(mockLegacyOpenCombineDialog).not.toHaveBeenCalled();
        expect(deps.openFile).not.toHaveBeenCalled();
        expect(deps.emitOpenInNewTab).not.toHaveBeenCalled();
        expect(deps.closeAllDropdowns).not.toHaveBeenCalled();
    });

    it('returns early without closing dropdowns when folder picker is cancelled', async () => {
        mockOpenFolderDialog.mockResolvedValue(null);
        const deps = createDeps();
        const { handleOpenFolderFromUi } = usePageFileOperations(deps);

        await handleOpenFolderFromUi();

        expect(mockOpenFolderDialog).toHaveBeenCalledOnce();
        expect(mockLegacyOpenFolderDialog).not.toHaveBeenCalled();
        expect(deps.openFile).not.toHaveBeenCalled();
        expect(deps.emitOpenInNewTab).not.toHaveBeenCalled();
        expect(deps.closeAllDropdowns).not.toHaveBeenCalled();
    });

    it('opens combined generated PDF in a new tab only when a document is already open', async () => {
        const generated = {
            kind: 'pdf' as const,
            originalPath: '/tmp/generated.pdf',
            workingPath: '/tmp/working.pdf',
            isGenerated: true,
        };
        mockOpenCombineDialog.mockResolvedValue(generated);

        const depsWithDoc = createDeps({ hasDocument: ref(true) });
        const opsWithDoc = usePageFileOperations(depsWithDoc);
        await opsWithDoc.handleCombineImages();

        expect(depsWithDoc.emitOpenInNewTab).toHaveBeenCalledWith(generated);
        expect(depsWithDoc.openFile).not.toHaveBeenCalled();
        expect(depsWithDoc.closeAllDropdowns).toHaveBeenCalledOnce();

        mockOpenCombineDialog.mockResolvedValue(generated);
        const depsNoDoc = createDeps({ hasDocument: ref(false) });
        const opsNoDoc = usePageFileOperations(depsNoDoc);
        await opsNoDoc.handleCombineImages();

        expect(depsNoDoc.emitOpenInNewTab).not.toHaveBeenCalled();
        expect(depsNoDoc.openFile).toHaveBeenCalledWith(generated);
        expect(depsNoDoc.closeAllDropdowns).toHaveBeenCalledOnce();
    });

    it('opens combined generated PDF in a new tab while a DjVu document is open', async () => {
        const generated = {
            kind: 'pdf' as const,
            originalPath: '/tmp/generated-from-djvu.pdf',
            workingPath: '/tmp/working-from-djvu.pdf',
            isGenerated: true,
        };
        mockOpenCombineDialog.mockResolvedValue(generated);
        const deps = createDeps({
            pdfSrc: ref(null),
            hasDocument: ref(true),
        });
        const { handleCombineImages } = usePageFileOperations(deps);

        await handleCombineImages();

        expect(deps.emitOpenInNewTab).toHaveBeenCalledWith(generated);
        expect(deps.openFile).not.toHaveBeenCalled();
        expect(deps.closeAllDropdowns).toHaveBeenCalledOnce();
    });

    it('removes a missing browser recent file and notifies instead of opening it', async () => {
        const warnSpy = vi.spyOn(BrowserLogger, 'warn').mockImplementation(() => {});
        mockReadFileRange.mockRejectedValueOnce(new Error('Browser document chunk missing'));
        const deps = createDeps();
        const { openRecentFile } = usePageFileOperations(deps);
        const file = {
            originalPath: 'browser://documents/uuid/missing.pdf',
            fileName: 'missing.pdf',
            timestamp: 0,
            fileSize: 0,
        };

        await openRecentFile(file);

        expect(deps.openFileDirect).not.toHaveBeenCalled();
        expect(deps.removeRecentFile).toHaveBeenCalledWith(file);
        expect(deps.notifyMissingRecentFile).toHaveBeenCalledWith(file);
        expect(warnSpy).toHaveBeenCalledWith(
            'recent-open',
            'Recent file no longer exists; removing from recents',
            {path: 'browser://documents/uuid/missing.pdf'},
        );
    });

    it('removes a recent whose browser storage chunks were evicted', async () => {
        mockReadFileRange.mockRejectedValueOnce(new Error('Browser document chunk missing: browser://documents/uuid/file.pdf#0'));
        const deps = createDeps();
        const { openRecentFile } = usePageFileOperations(deps);
        const file = {
            originalPath: 'browser://documents/uuid/file.pdf',
            fileName: 'file.pdf',
            timestamp: 0,
            fileSize: 32_000_000,
        };

        await openRecentFile(file);

        expect(deps.openFileDirect).not.toHaveBeenCalled();
        expect(deps.removeRecentFile).toHaveBeenCalledWith(file);
        expect(deps.notifyMissingRecentFile).toHaveBeenCalledWith(file);
    });

    it('opens a present browser recent file without removing or notifying', async () => {
        mockReadFileRange.mockResolvedValueOnce(new Uint8Array([37]));
        const deps = createDeps();
        const { openRecentFile } = usePageFileOperations(deps);
        const file = {
            originalPath: 'browser://documents/uuid/present.pdf',
            fileName: 'present.pdf',
            timestamp: 0,
            fileSize: 4096,
        };

        await openRecentFile(file);

        expect(mockReadFileRange).toHaveBeenCalledWith('browser://documents/uuid/present.pdf', 0, 1);
        expect(deps.openFileDirect).toHaveBeenCalledWith('browser://documents/uuid/present.pdf');
        expect(deps.removeRecentFile).not.toHaveBeenCalled();
        expect(deps.notifyMissingRecentFile).not.toHaveBeenCalled();
    });

    it('does not probe native recent paths before direct-open', async () => {
        mockReadFileRange.mockRejectedValueOnce(new Error('Invalid file path: reads only allowed within temp directory'));
        const deps = createDeps();
        const { openRecentFile } = usePageFileOperations(deps);
        const file = {
            originalPath: '/tmp/present.pdf',
            fileName: 'present.pdf',
            timestamp: 0,
            fileSize: 4096,
        };

        await openRecentFile(file);

        expect(mockReadFileRange).not.toHaveBeenCalled();
        expect(deps.openFileDirect).toHaveBeenCalledWith('/tmp/present.pdf');
        expect(deps.removeRecentFile).not.toHaveBeenCalled();
        expect(deps.notifyMissingRecentFile).not.toHaveBeenCalled();
    });

    it('blocks close when save throws instead of bubbling an uncaught rejection', async () => {
        const errorSpy = vi.spyOn(BrowserLogger, 'error').mockImplementation(() => {});
        const deps = createDeps({
            isDirty: ref(true),
            handleSave: vi.fn(async () => {
                throw new Error('cannot save');
            }),
        });
        const { handleCloseFileFromUi } = usePageFileOperations(deps);

        await expect(handleCloseFileFromUi()).resolves.toBe(false);

        expect(deps.closeFile).not.toHaveBeenCalled();
        expect(deps.closeAllDropdowns).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(
            'recent-open',
            'Switch blocked: save before switch threw',
            { error: 'cannot save' },
        );
    });

    it('keeps a browser recent entry when the probe is denied by capability or token policy', async () => {
        mockReadFileRange.mockRejectedValueOnce(new Error('Capability token denied'));
        const deps = createDeps();
        const { openRecentFile } = usePageFileOperations(deps);
        const file = {
            originalPath: 'browser://documents/uuid/denied.pdf',
            fileName: 'denied.pdf',
            timestamp: 0,
            fileSize: 4096,
        };

        await openRecentFile(file);

        expect(deps.openFileDirect).toHaveBeenCalledWith('browser://documents/uuid/denied.pdf');
        expect(deps.removeRecentFile).not.toHaveBeenCalled();
        expect(deps.notifyMissingRecentFile).not.toHaveBeenCalled();
    });
});
