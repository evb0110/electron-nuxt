import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import { IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES } from '@contracts/electronApiDocuments';
import type { TTranslateFn } from '@i18n-app';
import {
    clearRegisteredPdfRasterDisplayProfilesForTests,
    getRegisteredPdfRasterDisplayProfileCountForTests,
    registerPdfRasterDisplayProfile,
} from '@app/types/pdfRasterDisplayProfile';
import {
    createDocumentSessionState,
    createEpochGuard,
} from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import { createDocumentOpenFlow } from '@app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow';
import {BrowserFilePickerSetupDeniedError} from '@app/platform/browser-api/browserFilePickerAdapter';
import { createDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import type { IDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import {
    invalidateTrustedPdfOpenGeometry,
    readPrevalidatedTrustedPdfOpenGeometry,
    rememberValidatedTrustedPdfOpenGeometry,
} from '@app/modules/pdf-viewer/runtime/lifecycle/pdfTrustedOpenGeometryCache';
import {clearPdfValidationRevisionCacheForTests} from '@app/modules/workspace-shell/composables/document-session/pdfValidationRevisionCache';

const mocks = vi.hoisted(() => ({
    documentFiles: {
        readFile: vi.fn(),
        readFileRange: vi.fn(),
        statFile: vi.fn(),
        writeFile: vi.fn(),
        getPdfOpeningGeometry: vi.fn(),
        getDocumentRevision: vi.fn(),
    },
    documentOpen: {
        onOpenDocumentDirectBatchProgress: vi.fn(() => vi.fn()),
        openDocumentDirect: vi.fn(),
        openDocumentDirectBatch: vi.fn(),
    },
    documentPdf: {validatePdfPath: vi.fn()},
    documentPicker: { openDocumentDialog: vi.fn() },
    documentRecentFiles: {recentFiles: {get: vi.fn()}},
    performanceProfile: {
        lowCpu: false,
        lowMemory: false,
    },
    nativePreview: {createSource: vi.fn()},
}));

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentFilesCapability: () => mocks.documentFiles,
    getDocumentOpenCapability: () => mocks.documentOpen,
    getDocumentPdfCapability: () => mocks.documentPdf,
    getDocumentPickerCapability: () => mocks.documentPicker,
    getDocumentRecentFilesCapability: () => mocks.documentRecentFiles,
}));
vi.mock('@app/utils/performanceProfile', () => ({getPerformanceProfile: () => mocks.performanceProfile}));
vi.mock('@app/platform/browser-api/createNativePdfPreviewSourceFromPath', () => ({createNativePdfPreviewSourceFromPath: mocks.nativePreview.createSource}));

const PDF_BYTES = Uint8Array.from([
    37,
    80,
    68,
    70,
]);
interface IResetHistoryTestOptions {
    reuseSnapshot?: boolean;
    isCurrent?: (() => boolean) | undefined;
}

function createOpenFlowHarness(options: {openSurface?: IDocumentOpenSurfaceSession;} = {}) {
    const state = createDocumentSessionState({ isDesktopRuntime: ref(true) });
    const analyticsDocumentScope = {
        activate: vi.fn(),
        clear: vi.fn(),
        deactivate: vi.fn(),
        dispose: vi.fn(),
        key: 'test-document-scope',
        merge: vi.fn(),
        set: vi.fn(),
    };
    const deps = {
        analytics: {
            clearDocumentContext: vi.fn(),
            createDocumentScope: vi.fn(() => analyticsDocumentScope),
            enabled: false,
            flush: vi.fn(async () => undefined),
            installLifecycle: vi.fn(),
            mergeDocumentContext: vi.fn(),
            setDocumentContext: vi.fn(),
            track: vi.fn(),
        },
        analyticsDocumentScope,
        cleanupAbandonedWorkingCopy: vi.fn(async () => undefined),
        clearPdfConformanceProfile: vi.fn(),
        cleanupPreviousWorkingCopy: vi.fn(async () => undefined),
        deferPdfConformanceProfile: vi.fn(),
        ensureHistoryBaselineForMutation: vi.fn(async () => true),
        incrementSessionVersion: vi.fn(),
        loadEpoch: createEpochGuard(),
        openSurface: options.openSurface,
        openEpoch: createEpochGuard(),
        pushHistorySnapshot: vi.fn(async () => true),
        resetHistory: vi.fn(async (_snapshot, options?: IResetHistoryTestOptions) => options?.isCurrent?.() !== false),
        syncDirtyFromHistory: vi.fn(),
        t: ((key: string) => key) as TTranslateFn,
    };

    return {
        analyticsDocumentScope,
        deps,
        openFlow: createDocumentOpenFlow(state, deps),
        state,
    };
}

describe('createDocumentOpenFlow', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearPdfValidationRevisionCacheForTests();
        clearRegisteredPdfRasterDisplayProfilesForTests();
        mocks.documentFiles.statFile.mockResolvedValue({ size: PDF_BYTES.byteLength });
        mocks.documentFiles.readFile.mockResolvedValue(PDF_BYTES);
        mocks.documentFiles.readFileRange.mockResolvedValue(new Uint8Array());
        mocks.documentFiles.writeFile.mockResolvedValue(true);
        mocks.documentPdf.validatePdfPath.mockResolvedValue({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
        mocks.documentRecentFiles.recentFiles.get.mockResolvedValue([]);
        mocks.documentFiles.getPdfOpeningGeometry.mockResolvedValue({
            pageNumber: 1,
            pageCount: 1,
            width: 612,
            height: 792,
            rotation: 0,
            size: PDF_BYTES.byteLength,
            modifiedAt: 1,
        });
        mocks.documentFiles.getDocumentRevision.mockImplementation(async (path: string) => ({
            version: 1,
            token: `revision:${path}`,
            documentRef: path,
            authority: 'electron-working-copy',
            contentRevision: 0,
            mintedAt: 1,
        }));
        mocks.performanceProfile.lowCpu = false;
        mocks.performanceProfile.lowMemory = false;
    });

    it('shows one native first-page raster while validation is still pending', async () => {
        const originalPath = '/documents/dictionary.pdf';
        const workingPath = '/tmp/dictionary-working.pdf';
        const size = 170_496_793;
        const modifiedAt = 1_724_000_000_000;
        const openingGeometry = {
            pageNumber: 1 as const,
            pageCount: 1_859,
            width: 612,
            height: 792,
            rotation: 0 as const,
            size,
            modifiedAt,
            linearized: false,
        };
        const openSurface = createDocumentOpenSurfaceSession();
        const generation = openSurface.beginPrepared({
            documentId: originalPath,
            documentRevision: 'open-intent:111',
        }, {
            documentId: originalPath,
            ownerId: 'test-chassis',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            layoutKey: '1000x800',
            policyKey: 'width:single:fit-width:1',
            sourceRevisionKey: `${String(size)}:${String(modifiedAt)}`,
            style: {
                width: '900px',
                height: '1165px',
            },
            geometry: {
                documentId: originalPath,
                ...openingGeometry,
            },
        });
        expect(generation).not.toBeNull();
        const validationGate = Promise.withResolvers<{
            isValid: true;
            tool: 'qpdf';
            errors: never[];
            warnings: never[];
        }>();
        mocks.documentPdf.validatePdfPath.mockReturnValue(validationGate.promise);
        mocks.documentFiles.statFile.mockImplementation(async (path: string) => path === originalPath
            ? {
                size,
                modifiedAt,
            }
            : {size});
        const geometryGate = Promise.withResolvers<typeof openingGeometry>();
        mocks.documentFiles.getPdfOpeningGeometry.mockReturnValue(geometryGate.promise);
        const terminate = vi.fn();
        const renderPageObjectUrl = vi.fn(async () => ({
            objectUrl: 'blob:native-opening-page-one',
            renderedPx: 1_800,
            onInvalidated: vi.fn(() => vi.fn()),
            promotePriority: vi.fn(),
        }));
        mocks.nativePreview.createSource.mockReturnValue({
            cancelPagePreview: vi.fn(),
            getPageSizes: vi.fn(),
            renderPageObjectUrl,
            revokeObjectURL: vi.fn(),
            terminate,
        });
        const {
            openFlow,
            state,
        } = createOpenFlowHarness({openSurface});

        const opening = openFlow.openFile({
            kind: 'pdf',
            originalPath,
            workingPath,
        });

        await vi.waitFor(() => {
            expect(mocks.documentPdf.validatePdfPath).toHaveBeenCalledWith(workingPath);
        });
        expect(renderPageObjectUrl).not.toHaveBeenCalled();
        geometryGate.resolve(openingGeometry);
        await vi.waitFor(() => {
            expect(openSurface.snapshot.value.openingPageFrame?.preview).toMatchObject({
                objectUrl: 'blob:native-opening-page-one',
                pageNumber: 1,
                sourceRevisionKey: `${String(size)}:${String(modifiedAt)}`,
            });
        });
        expect(renderPageObjectUrl).toHaveBeenCalledOnce();
        expect(renderPageObjectUrl).toHaveBeenCalledWith(1, expect.objectContaining({targetWidthPx: 900}));
        expect(terminate).not.toHaveBeenCalled();
        expect(state.pdfOpeningSrc.value).toEqual({
            kind: 'path',
            path: workingPath,
            size,
        });
        expect(state.pdfSrc.value).toBeNull();

        validationGate.resolve({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
        await expect(opening).resolves.toMatchObject({status: 'opened'});
        expect(terminate).not.toHaveBeenCalled();
        expect(state.pdfOpeningSrc.value).toBeNull();

        openSurface.reset();
        expect(terminate).toHaveBeenCalledOnce();
    });

    it('waits for the host to claim an idle opening surface and commit its late page frame', async () => {
        const originalPath = '/documents/late-frame-dictionary.pdf';
        const workingPath = '/tmp/late-frame-dictionary-working.pdf';
        const size = 722_049_367;
        const modifiedAt = 1_776_000_000_000;
        const openingGeometry = {
            pageNumber: 1 as const,
            pageCount: 882,
            width: 612,
            height: 792,
            rotation: 0 as const,
            size,
            modifiedAt,
            linearized: false,
        };
        const openSurface = createDocumentOpenSurfaceSession();
        const validationGate = Promise.withResolvers<{
            isValid: true;
            tool: 'qpdf';
            errors: never[];
            warnings: never[];
        }>();
        const geometryGate = Promise.withResolvers<typeof openingGeometry>();
        mocks.documentPdf.validatePdfPath.mockReturnValue(validationGate.promise);
        mocks.documentFiles.getPdfOpeningGeometry.mockReturnValue(geometryGate.promise);
        mocks.documentFiles.statFile.mockImplementation(async path => path === originalPath
            ? {
                size,
                modifiedAt,
            }
            : {size});
        const renderPageObjectUrl = vi.fn(async () => ({
            objectUrl: 'blob:native-opening-late-frame',
            renderedPx: 1_800,
        }));
        mocks.nativePreview.createSource.mockReturnValue({
            cancelPagePreview: vi.fn(),
            getPageSizes: vi.fn(),
            renderPageObjectUrl,
            revokeObjectURL: vi.fn(),
            terminate: vi.fn(),
        });
        const {openFlow} = createOpenFlowHarness({openSurface});

        const opening = openFlow.openFile({
            kind: 'pdf',
            originalPath,
            workingPath,
        });

        await vi.waitFor(() => {
            expect(mocks.documentPdf.validatePdfPath).toHaveBeenCalledWith(workingPath);
        });
        geometryGate.resolve(openingGeometry);
        await vi.waitFor(() => {
            expect(mocks.documentFiles.getPdfOpeningGeometry).toHaveBeenCalledWith(workingPath);
        });
        expect(openSurface.snapshot.value.phase).toBe('idle');
        expect(renderPageObjectUrl).not.toHaveBeenCalled();

        const generation = openSurface.begin({
            documentId: originalPath,
            documentRevision: 'open-intent:late-frame',
        });
        expect(generation).not.toBeNull();
        await vi.waitFor(() => {
            expect(openSurface.snapshot.value.openingPageGeometry).toMatchObject({
                documentId: originalPath,
                pageCount: 882,
            });
        });
        if (generation === null) {
            throw new Error('Expected the host opening surface to accept the transaction');
        }
        expect(openSurface.snapshot.value.identity).toEqual({
            documentId: originalPath,
            documentRevision: 'open-intent:late-frame',
        });
        expect(renderPageObjectUrl).not.toHaveBeenCalled();

        expect(openSurface.commitOpeningPageFrame(generation, {
            generation,
            ownerId: 'late-test-chassis',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            sourceRevisionKey: `${String(size)}:${String(modifiedAt)}`,
            style: {
                width: '900px',
                height: '1165px',
            },
        })).toBe(true);
        await vi.waitFor(() => {
            expect(openSurface.snapshot.value.openingPageFrame?.preview).toMatchObject({
                objectUrl: 'blob:native-opening-late-frame',
                pageNumber: 1,
            });
        });
        expect(renderPageObjectUrl).toHaveBeenCalledOnce();

        validationGate.resolve({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
        await expect(opening).resolves.toMatchObject({status: 'opened'});
    });

    it('cancels an in-flight native opening raster when validation rejects the PDF', async () => {
        const originalPath = '/documents/corrupt-dictionary.pdf';
        const size = 170_496_793;
        const modifiedAt = 1_724_000_000_000;
        const openingGeometry = {
            pageNumber: 1 as const,
            pageCount: 1_859,
            width: 612,
            height: 792,
            rotation: 0 as const,
            size,
            modifiedAt,
            linearized: false,
        };
        const openSurface = createDocumentOpenSurfaceSession();
        openSurface.beginPrepared({
            documentId: originalPath,
            documentRevision: 'open-intent:invalid',
        }, {
            documentId: originalPath,
            ownerId: 'test-chassis',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            layoutKey: '1000x800',
            policyKey: 'width:single:fit-width:1',
            sourceRevisionKey: `${String(size)}:${String(modifiedAt)}`,
            style: {
                width: '900px',
                height: '1165px',
            },
            geometry: {
                documentId: originalPath,
                ...openingGeometry,
            },
        });
        const rasterGate = Promise.withResolvers<{
            objectUrl: string;
            renderedPx: number;
        }>();
        const terminate = vi.fn();
        const renderPageObjectUrl = vi.fn(() => rasterGate.promise);
        mocks.nativePreview.createSource.mockReturnValue({
            cancelPagePreview: vi.fn(),
            getPageSizes: vi.fn(),
            renderPageObjectUrl,
            revokeObjectURL: vi.fn(),
            terminate,
        });
        mocks.documentFiles.statFile.mockResolvedValue({size});
        mocks.documentFiles.getPdfOpeningGeometry.mockResolvedValue(openingGeometry);
        const validationGate = Promise.withResolvers<{
            isValid: false;
            tool: 'qpdf';
            errors: string[];
            warnings: never[];
        }>();
        mocks.documentPdf.validatePdfPath.mockReturnValue(validationGate.promise);
        const {
            openFlow,
            state,
        } = createOpenFlowHarness({openSurface});

        const opening = openFlow.openFile({
            kind: 'pdf',
            originalPath,
            workingPath: '/tmp/corrupt-dictionary-working.pdf',
            openingGeometry,
        });
        await vi.waitFor(() => {
            expect(renderPageObjectUrl).toHaveBeenCalledOnce();
        });
        validationGate.resolve({
            isValid: false,
            tool: 'qpdf',
            errors: ['damaged xref table'],
            warnings: [],
        });
        await expect(opening).resolves.toMatchObject({status: 'failed'});

        expect(terminate).toHaveBeenCalledOnce();
        expect(openSurface.snapshot.value.openingPageFrame?.preview).toBeUndefined();
        expect(state.pdfOpeningSrc.value).toBeNull();
    });

    it('retires native resources when a second open supersedes validation', async () => {
        const originalPath = '/documents/first-dictionary.pdf';
        const workingPath = '/tmp/first-dictionary-working.pdf';
        const size = 170_496_793;
        const modifiedAt = 1_724_000_000_000;
        const openingGeometry = {
            pageNumber: 1 as const,
            pageCount: 1_859,
            width: 612,
            height: 792,
            rotation: 0 as const,
            size,
            modifiedAt,
            linearized: false,
        };
        const openSurface = createDocumentOpenSurfaceSession();
        openSurface.beginPrepared({
            documentId: originalPath,
            documentRevision: 'open-intent:first',
        }, {
            documentId: originalPath,
            ownerId: 'test-chassis',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            layoutKey: '1000x800',
            policyKey: 'width:single:fit-width:1',
            sourceRevisionKey: `${String(size)}:${String(modifiedAt)}`,
            style: {
                width: '900px',
                height: '1165px',
            },
            geometry: {
                documentId: originalPath,
                ...openingGeometry,
            },
        });
        const firstValidation = Promise.withResolvers<{
            isValid: true;
            tool: 'qpdf';
            errors: never[];
            warnings: never[];
        }>();
        mocks.documentPdf.validatePdfPath.mockImplementation((path: string) => path === workingPath
            ? firstValidation.promise
            : Promise.resolve({
                isValid: true as const,
                tool: 'qpdf' as const,
                errors: [],
                warnings: [],
            }));
        mocks.documentFiles.statFile.mockImplementation(async (path: string) => path === originalPath
            ? {
                size,
                modifiedAt,
            }
            : {size});
        mocks.documentFiles.getPdfOpeningGeometry.mockResolvedValue(openingGeometry);
        const terminate = vi.fn();
        mocks.nativePreview.createSource.mockReturnValue({
            cancelPagePreview: vi.fn(),
            getPageSizes: vi.fn(),
            renderPageObjectUrl: vi.fn(async () => ({
                objectUrl: 'blob:first-native-opening',
                renderedPx: 1_800,
            })),
            revokeObjectURL: vi.fn(),
            terminate,
        });
        const {
            openFlow,
            state,
        } = createOpenFlowHarness({openSurface});

        const firstOpen = openFlow.openFile({
            kind: 'pdf',
            originalPath,
            workingPath,
        });
        await vi.waitFor(() => {
            expect(openSurface.snapshot.value.openingPageFrame?.preview?.objectUrl)
                .toBe('blob:first-native-opening');
        });

        await expect(openFlow.openFile({
            kind: 'pdf',
            originalPath: '/documents/replacement.pdf',
            workingPath: '/tmp/replacement-working.pdf',
            openingGeometry: {
                pageNumber: 1,
                pageCount: 1,
                width: 612,
                height: 792,
                rotation: 0,
                size: PDF_BYTES.byteLength,
                modifiedAt: 2,
                linearized: true,
            },
        })).resolves.toMatchObject({status: 'opened'});

        expect(terminate).toHaveBeenCalledOnce();
        expect(openSurface.snapshot.value.openingPageFrame?.preview).toBeUndefined();
        expect(state.pdfOpeningSrc.value).toBeNull();
        firstValidation.resolve({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
        await expect(firstOpen).resolves.toMatchObject({status: 'stale'});
        expect(terminate).toHaveBeenCalledOnce();
    });

    it('reuses successful validation only for the same immutable source revision', async () => {
        const {openFlow} = createOpenFlowHarness();
        const result = {
            kind: 'pdf' as const,
            originalPath: '/documents/reopened.pdf',
            workingPath: '/tmp/reopened-working.pdf',
            openingGeometry: {
                pageNumber: 1 as const,
                pageCount: 10,
                width: 612,
                height: 792,
                rotation: 0 as const,
                size: PDF_BYTES.byteLength,
                modifiedAt: 100,
            },
        };

        await expect(openFlow.openFile(result)).resolves.toMatchObject({status: 'opened'});
        await expect(openFlow.openFile(result)).resolves.toMatchObject({status: 'opened'});
        await expect(openFlow.openFile({
            ...result,
            openingGeometry: {
                ...result.openingGeometry,
                modifiedAt: 101,
            },
        })).resolves.toMatchObject({status: 'opened'});

        expect(mocks.documentPdf.validatePdfPath).toHaveBeenCalledTimes(2);
    });

    it('reads PDF state with the split document files stat capability', async () => {
        const { openFlow } = createOpenFlowHarness();

        const nextState = await openFlow.readPdfStateFromPath('/tmp/work.pdf');

        expect(nextState.pdfData).toEqual(PDF_BYTES);
        expect(mocks.documentFiles.statFile).toHaveBeenCalledWith('/tmp/work.pdf');
        expect(mocks.documentFiles.readFile).toHaveBeenCalledWith('/tmp/work.pdf');
    });

    it('localizes browser picker setup denial without exposing its transport code', async () => {
        mocks.documentPicker.openDocumentDialog.mockRejectedValueOnce(
            new BrowserFilePickerSetupDeniedError(),
        );
        const {
            openFlow,
            state,
        } = createOpenFlowHarness();

        await expect(openFlow.openFile()).resolves.toEqual({
            status: 'failed',
            error: 'errors.browser.filePickerSetupDenied',
        });
        expect(state.error.value).toBe('errors.browser.filePickerSetupDenied');
    });

    it('retains the active PDF when a staged replacement fails parser validation', async () => {
        const {
            deps,
            openFlow,
            state,
        } = createOpenFlowHarness();
        const activeData = Uint8Array.of(1, 2, 3);
        const activeSource = new Blob([activeData], {type: 'application/pdf'});
        state.originalPath.value = '/documents/active.pdf';
        state.workingCopyPath.value = '/tmp/active-working.pdf';
        state.pdfData.value = activeData;
        state.pdfSrc.value = activeSource;
        state.pdfReloadSrc.value = activeSource;
        state.isDirty.value = true;
        const corruptCandidate: TOpenFileResult = {
            kind: 'pdf',
            originalPath: '/documents/corrupt.pdf',
            workingPath: '/tmp/corrupt-working.pdf',
        };
        mocks.documentPdf.validatePdfPath.mockResolvedValueOnce({
            isValid: false,
            tool: 'qpdf',
            errors: ['damaged xref table'],
            warnings: [],
        });

        await expect(openFlow.openFile(corruptCandidate)).resolves.toMatchObject({
            status: 'failed',
            error: 'errors.file.invalid',
        });

        expect(mocks.documentPdf.validatePdfPath).toHaveBeenCalledWith('/tmp/corrupt-working.pdf');
        expect(state.originalPath.value).toBe('/documents/active.pdf');
        expect(state.workingCopyPath.value).toBe('/tmp/active-working.pdf');
        expect(state.pdfData.value).toBe(activeData);
        expect(state.pdfSrc.value).toBe(activeSource);
        expect(state.pdfReloadSrc.value).toBe(activeSource);
        expect(state.isDirty.value).toBe(true);
        expect(deps.resetHistory).not.toHaveBeenCalled();
        expect(deps.cleanupPreviousWorkingCopy).not.toHaveBeenCalled();
        expect(deps.cleanupAbandonedWorkingCopy).toHaveBeenCalledWith('/tmp/corrupt-working.pdf');
    });

    it('keeps PDFs above the direct IPC ceiling path-backed', async () => {
        const { openFlow } = createOpenFlowHarness();
        const size = IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES + 1;
        mocks.documentFiles.statFile.mockResolvedValue({ size });

        const nextState = await openFlow.readPdfStateFromPath('/tmp/large-work.pdf');

        expect(nextState).toEqual({
            pdfData: null,
            pdfSrc: {
                kind: 'path',
                path: '/tmp/large-work.pdf',
                size,
            },
        });
        expect(mocks.documentFiles.readFile).not.toHaveBeenCalled();
        expect(mocks.documentFiles.readFileRange).not.toHaveBeenCalled();
    });

    it('keeps the inclusive 4 MiB low-memory boundary in memory', async () => {
        mocks.performanceProfile.lowMemory = true;
        const size = 4 * 1024 * 1024;
        const data = new Uint8Array(size);
        mocks.documentFiles.statFile.mockResolvedValue({size});
        mocks.documentFiles.readFile.mockResolvedValue(data);
        const {openFlow} = createOpenFlowHarness();

        const nextState = await openFlow.readPdfStateFromPath('/tmp/boundary.pdf');

        expect(nextState.pdfData).toBe(data);
        expect(nextState.pdfSrc).toBeInstanceOf(Blob);
        expect(mocks.documentFiles.readFile).toHaveBeenCalledWith('/tmp/boundary.pdf');
    });

    it('keeps a low-memory PDF one byte above 4 MiB path-backed', async () => {
        mocks.performanceProfile.lowMemory = true;
        const size = (4 * 1024 * 1024) + 1;
        mocks.documentFiles.statFile.mockResolvedValue({size});
        const {openFlow} = createOpenFlowHarness();

        await expect(openFlow.readPdfStateFromPath('/tmp/above-boundary.pdf')).resolves.toEqual({
            pdfData: null,
            pdfSrc: {
                kind: 'path',
                path: '/tmp/above-boundary.pdf',
                size,
            },
        });
        expect(mocks.documentFiles.readFile).not.toHaveBeenCalled();
        expect(mocks.documentFiles.readFileRange).not.toHaveBeenCalled();
    });

    it('opens an 8 MiB plus one low-memory PDF with empty clean file history', async () => {
        mocks.performanceProfile.lowMemory = true;
        const size = (8 * 1024 * 1024) + 1;
        mocks.documentFiles.statFile.mockResolvedValue({size});
        const {
            deps,
            openFlow,
        } = createOpenFlowHarness();

        await expect(openFlow.openFile({
            kind: 'pdf',
            originalPath: '/tmp/medium.pdf',
            workingPath: '/tmp/medium-working.pdf',
        })).resolves.toMatchObject({status: 'opened'});

        expect(deps.resetHistory).toHaveBeenCalledWith(null, {isCurrent: expect.any(Function)});
        expect(deps.pushHistorySnapshot).not.toHaveBeenCalled();
        expect(mocks.documentFiles.readFile).not.toHaveBeenCalled();
        expect(mocks.documentFiles.readFileRange).not.toHaveBeenCalled();
    });

    it('preserves the eager normal-profile baseline above 8 MiB', async () => {
        const size = (8 * 1024 * 1024) + 1;
        mocks.documentFiles.statFile.mockResolvedValue({size});
        mocks.documentFiles.readFileRange.mockImplementation(async (
            _path: string,
            _offset: number,
            length: number,
        ) => new Uint8Array(length));
        const {
            deps,
            openFlow,
        } = createOpenFlowHarness();

        await expect(openFlow.openFile({
            kind: 'pdf',
            originalPath: '/tmp/normal-medium.pdf',
            workingPath: '/tmp/normal-medium-working.pdf',
        })).resolves.toMatchObject({status: 'opened'});

        expect(deps.resetHistory).toHaveBeenCalledWith(
            expect.objectContaining({byteLength: size}),
            {
                reuseSnapshot: true,
                isCurrent: expect.any(Function),
            },
        );
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

        expect(mocks.documentFiles.writeFile).toHaveBeenCalledWith('/tmp/work.pdf', snapshot, undefined);
    });

    it('does not apply or persist PDF data when mutation baseline staging fails', async () => {
        const {
            deps,
            openFlow,
            state,
        } = createOpenFlowHarness();
        const before = new Uint8Array([1]);
        state.workingCopyPath.value = '/tmp/work.pdf';
        state.pdfData.value = before;
        deps.ensureHistoryBaselineForMutation.mockResolvedValue(false);

        await expect(openFlow.loadPdfFromData(
            new Uint8Array([2]),
            {persistWorkingCopy: true},
        )).resolves.toBeUndefined();

        expect(mocks.documentFiles.writeFile).not.toHaveBeenCalled();
        expect(deps.pushHistorySnapshot).not.toHaveBeenCalled();
        expect(state.pdfData.value).toBe(before);
    });

    it('tracks preselected DjVu opens without statting the external source path', async () => {
        const {
            analyticsDocumentScope,
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

        expect(outcome.status).toBe('prepared');
        expect(state.pendingDjvu.value).toBe('/tmp/scan.djvu');
        expect(mocks.documentFiles.statFile).not.toHaveBeenCalledWith('/tmp/scan.djvu');
        expect(analyticsDocumentScope.set).toHaveBeenCalledWith(expect.objectContaining({
            documentKind: 'djvu',
            fileExtension: 'djvu',
            fileSizeBucket: null,
        }));
        expect(deps.analytics.track).toHaveBeenCalledWith('document_opened', expect.objectContaining({
            documentKind: 'djvu',
            fileExtension: 'djvu',
            fileSizeBucket: null,
            openMethod: 'preselected',
            requiresSaveAsOnFirstSave: false,
        }));
    });

    it('cleans up a stale direct PDF working copy that was superseded before adoption', async () => {
        const {
            deps,
            openFlow,
            state,
        } = createOpenFlowHarness();
        const staleResult: TOpenFileResult = {
            kind: 'pdf',
            originalPath: '/stale.pdf',
            workingPath: '/tmp/stale-working.pdf',
            isGenerated: false,
        };
        const freshResult: TOpenFileResult = {
            kind: 'pdf',
            originalPath: '/fresh.pdf',
            workingPath: '/tmp/fresh-working.pdf',
            isGenerated: false,
        };
        const staleGate = Promise.withResolvers<TOpenFileResult>();
        mocks.documentOpen.openDocumentDirect.mockImplementation(async (path: string) => {
            if (path === '/stale.pdf') {
                return staleGate.promise;
            }
            return freshResult;
        });
        mocks.documentFiles.statFile.mockResolvedValue({ size: PDF_BYTES.byteLength });
        mocks.documentFiles.readFile.mockResolvedValue(PDF_BYTES);

        const staleOpen = openFlow.openFileDirect('/stale.pdf');
        await expect(openFlow.openFileDirect('/fresh.pdf')).resolves.toMatchObject({
            status: 'opened',
            result: freshResult,
        });

        staleGate.resolve(staleResult);
        await expect(staleOpen).resolves.toMatchObject({
            status: 'stale',
            result: staleResult,
        });

        expect(state.workingCopyPath.value).toBe('/tmp/fresh-working.pdf');
        expect(deps.cleanupAbandonedWorkingCopy).toHaveBeenCalledWith('/tmp/stale-working.pdf');
        expect(deps.cleanupAbandonedWorkingCopy).not.toHaveBeenCalledWith('/tmp/fresh-working.pdf');
    });

    it('adopts direct-open raster display profiles for the opened PDF only', async () => {
        const {
            openFlow,
            state,
        } = createOpenFlowHarness();
        const profile = {
            kind: 'trusted-raster-djvu' as const,
            sourcePagePixels: [{
                width: 1293,
                height: 1966,
            }],
        };
        mocks.documentOpen.openDocumentDirect.mockImplementation(async (path: string) => ({
            kind: 'pdf',
            originalPath: path,
            workingPath: `/tmp/${path.replaceAll('/', '')}`,
        }));

        await expect(openFlow.openFileDirect('/scan.pdf', {rasterDisplayProfile: profile})).resolves.toMatchObject({status: 'opened'});

        expect(state.pdfRasterDisplayProfile.value).toStrictEqual(profile);

        await expect(openFlow.openFileDirect('/ordinary.pdf')).resolves.toMatchObject({status: 'opened'});

        expect(state.pdfRasterDisplayProfile.value).toBeNull();
    });

    it('adopts registered raster display profiles when reopening a generated PDF path', async () => {
        const {
            openFlow,
            state,
        } = createOpenFlowHarness();
        const profile = {
            kind: 'trusted-raster-djvu' as const,
            sourcePagePixels: [{
                width: 1293,
                height: 1966,
            }],
        };
        registerPdfRasterDisplayProfile('/tmp/generated.pdf', profile);
        mocks.documentOpen.openDocumentDirect.mockResolvedValue({
            kind: 'pdf',
            originalPath: '/tmp/generated.pdf',
            workingPath: '/tmp/generated-working.pdf',
        });

        await expect(openFlow.openFileDirect('/tmp/generated.pdf')).resolves.toMatchObject({status: 'opened'});

        expect(state.pdfRasterDisplayProfile.value).toStrictEqual(profile);
        expect(getRegisteredPdfRasterDisplayProfileCountForTests()).toBe(0);
        expect(mocks.documentFiles.statFile).toHaveBeenCalledWith('/tmp/generated.pdf');
        expect(mocks.documentFiles.statFile).toHaveBeenCalledWith('/tmp/generated-working.pdf');

        await expect(openFlow.openFileDirect('/tmp/generated.pdf')).resolves.toMatchObject({status: 'opened'});

        expect(state.pdfRasterDisplayProfile.value).toBeNull();
    });

    it('bounds pending raster display profile handoffs', () => {
        const profile = {
            kind: 'trusted-raster-djvu' as const,
            sourcePagePixels: [{
                width: 100,
                height: 200,
            }],
        };

        for (let index = 0; index < 100; index += 1) {
            registerPdfRasterDisplayProfile(`/tmp/generated-${index}.pdf`, profile);
        }

        expect(getRegisteredPdfRasterDisplayProfileCountForTests()).toBe(64);
    });

    it('consumes a raster display profile handoff even when the target open fails', async () => {
        const {
            openFlow,
            state,
        } = createOpenFlowHarness();
        const result: TOpenFileResult = {
            kind: 'pdf',
            originalPath: '/tmp/reused.pdf',
            workingPath: '/tmp/reused-working.pdf',
        };
        mocks.documentOpen.openDocumentDirect.mockResolvedValue(result);
        registerPdfRasterDisplayProfile('/tmp/reused.pdf', {
            kind: 'trusted-raster-djvu',
            sourcePagePixels: [{
                width: 100,
                height: 200,
            }],
        });
        mocks.documentFiles.readFile
            .mockRejectedValueOnce(new Error('load failed'))
            .mockResolvedValue(PDF_BYTES);

        await expect(openFlow.openFileDirect('/tmp/reused.pdf')).resolves.toMatchObject({status: 'failed'});
        expect(getRegisteredPdfRasterDisplayProfileCountForTests()).toBe(0);

        await expect(openFlow.openFileDirect('/tmp/reused.pdf')).resolves.toMatchObject({status: 'opened'});
        expect(state.pdfRasterDisplayProfile.value).toBeNull();
    });

    it('does not let a stale PDF open clobber dirty state or conformance after history reset', async () => {
        const {
            deps,
            openFlow,
            state,
        } = createOpenFlowHarness();
        const firstResult: TOpenFileResult = {
            kind: 'pdf',
            originalPath: '/first.pdf',
            workingPath: '/tmp/first-working.pdf',
            isGenerated: true,
        };
        const secondResult: TOpenFileResult = {
            kind: 'pdf',
            originalPath: '/second.pdf',
            workingPath: '/tmp/second-working.pdf',
            isGenerated: false,
        };
        const firstHistoryResetGate = Promise.withResolvers<undefined>();
        let resetHistoryCalls = 0;
        deps.resetHistory.mockImplementation(async (_snapshot, options?: IResetHistoryTestOptions) => {
            resetHistoryCalls += 1;
            if (resetHistoryCalls === 1) {
                await firstHistoryResetGate.promise;
            }
            return options?.isCurrent?.() !== false;
        });
        mocks.documentFiles.statFile.mockResolvedValue({ size: PDF_BYTES.byteLength });
        mocks.documentFiles.readFile.mockResolvedValue(PDF_BYTES);

        const firstOpen = openFlow.openFile(firstResult);
        await vi.waitFor(() => {
            expect(deps.resetHistory).toHaveBeenCalledTimes(1);
        });

        await expect(openFlow.openFile(secondResult)).resolves.toMatchObject({
            status: 'opened',
            result: secondResult,
        });

        firstHistoryResetGate.resolve(undefined);
        await expect(firstOpen).resolves.toMatchObject({
            status: 'stale',
            result: firstResult,
        });

        expect(state.workingCopyPath.value).toBe('/tmp/second-working.pdf');
        expect(state.originalPath.value).toBe('/second.pdf');
        expect(state.isDirty.value).toBe(false);
        expect(deps.deferPdfConformanceProfile).toHaveBeenCalledTimes(1);
        expect(deps.deferPdfConformanceProfile).toHaveBeenCalledWith('/tmp/second-working.pdf', { fileSize: PDF_BYTES.byteLength });
        expect(deps.cleanupPreviousWorkingCopy).toHaveBeenCalledWith('/tmp/first-working.pdf', '/tmp/second-working.pdf');
    });

    it('caches concurrent geometry without replacing an already-committed canvas', async () => {
        const originalPath = '/documents/concurrent.pdf';
        const workingPath = '/tmp/concurrent-working.pdf';
        const openSurface = createDocumentOpenSurfaceSession();
        openSurface.begin({
            documentId: originalPath,
            documentRevision: 'open-intent:1',
        });
        const geometryGate = Promise.withResolvers<{
            pageNumber: 1;
            pageCount: number;
            width: number;
            height: number;
            rotation: 0;
            size: number;
            modifiedAt: number;
        }>();
        const statGate = Promise.withResolvers<{size: number}>();
        mocks.documentFiles.getPdfOpeningGeometry.mockReturnValue(geometryGate.promise);
        mocks.documentFiles.statFile.mockImplementation((path: string) => path === originalPath
            ? Promise.resolve({
                size: 4_096,
                modifiedAt: 2_000,
            })
            : statGate.promise);
        const { openFlow } = createOpenFlowHarness({openSurface});
        const result = {
            kind: 'pdf' as const,
            originalPath,
            workingPath,
        };

        const open = openFlow.openFile(result);
        await vi.waitFor(() => {
            expect(mocks.documentFiles.getPdfOpeningGeometry).toHaveBeenCalledWith(workingPath);
            expect(mocks.documentFiles.statFile).toHaveBeenCalledWith(workingPath);
        });

        statGate.resolve({size: PDF_BYTES.byteLength});
        await expect(open).resolves.toMatchObject({status: 'opened'});

        const generation = openSurface.snapshot.value.generation;
        expect(openSurface.commitOpeningPageGeometry(generation, {
            documentId: originalPath,
            pageNumber: 1,
            pageCount: 8,
            width: 612,
            height: 792,
            rotation: 0,
        })).toBe(true);
        expect(openSurface.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 16,
        })).toBe(true);
        const renderFence = openSurface.createRenderFence({
            generation,
            documentRevision: 'open-intent:1',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        });
        expect(renderFence).not.toBeNull();
        if (!renderFence) {
            throw new Error('Expected a render fence for the committed opening canvas');
        }
        expect(openSurface.commitCanvas(renderFence)).toBe(true);
        const committedRender = openSurface.snapshot.value.committedRender;

        geometryGate.resolve({
            pageNumber: 1,
            pageCount: 8,
            width: 640,
            height: 900,
            rotation: 0,
            size: PDF_BYTES.byteLength,
            modifiedAt: 9_000,
        });
        await vi.waitFor(() => {
            expect(readPrevalidatedTrustedPdfOpenGeometry(originalPath, 1)).toMatchObject({
                size: 4_096,
                modifiedAt: 2_000,
                width: 640,
                height: 900,
            });
        });
        expect(openSurface.snapshot.value.openingPageGeometry).toMatchObject({
            documentId: originalPath,
            pageCount: 8,
            width: 612,
            height: 792,
        });
        expect(openSurface.snapshot.value.committedRender).toBe(committedRender);
        invalidateTrustedPdfOpenGeometry(originalPath, 1);
    });

    it('commits validated cached geometry before source loading settles', async () => {
        const originalPath = '/documents/cached.pdf';
        const workingPath = '/tmp/cached-working.pdf';
        const cachedGeometry = {
            documentId: originalPath,
            pageNumber: 1,
            pageCount: 12,
            width: 612,
            height: 792,
            rotation: 0,
            size: 1_000,
            modifiedAt: 2_000,
            savedAt: 3_000,
        };
        rememberValidatedTrustedPdfOpenGeometry(cachedGeometry);
        const openSurface = createDocumentOpenSurfaceSession();
        openSurface.begin({
            documentId: originalPath,
            documentRevision: 'open-intent:1',
        });
        const statGate = Promise.withResolvers<{size: number}>();
        mocks.documentFiles.statFile.mockReturnValue(statGate.promise);
        const { openFlow } = createOpenFlowHarness({openSurface});

        const open = openFlow.openFile({
            kind: 'pdf',
            originalPath,
            workingPath,
        });

        expect(openSurface.snapshot.value.openingPageGeometry).toEqual(cachedGeometry);
        statGate.resolve({size: PDF_BYTES.byteLength});
        await expect(open).resolves.toMatchObject({status: 'opened'});
        invalidateTrustedPdfOpenGeometry(originalPath, 1);
    });

    it('makes a constrained cold open without geometry IPC', async () => {
        mocks.performanceProfile.lowCpu = true;
        const originalPath = '/documents/constrained.pdf';
        invalidateTrustedPdfOpenGeometry(originalPath, 1);
        const openSurface = createDocumentOpenSurfaceSession();
        openSurface.begin({
            documentId: originalPath,
            documentRevision: 'open-intent:1',
        });
        const { openFlow } = createOpenFlowHarness({openSurface});

        await expect(openFlow.openFile({
            kind: 'pdf',
            originalPath,
            workingPath: '/tmp/constrained-working.pdf',
        })).resolves.toMatchObject({status: 'opened'});

        expect(mocks.documentFiles.getPdfOpeningGeometry).not.toHaveBeenCalled();
        expect(openSurface.snapshot.value.openingPageGeometry).toBeNull();
    });

    it('keeps validated cache-only geometry available on constrained opens', async () => {
        mocks.performanceProfile.lowMemory = true;
        const originalPath = '/documents/constrained-cached.pdf';
        const cachedGeometry = {
            documentId: originalPath,
            pageNumber: 1,
            pageCount: 42,
            width: 612,
            height: 792,
            rotation: 0,
            size: 4_096,
            modifiedAt: 2_000,
            savedAt: 3_000,
        };
        rememberValidatedTrustedPdfOpenGeometry(cachedGeometry);
        const openSurface = createDocumentOpenSurfaceSession();
        openSurface.begin({
            documentId: originalPath,
            documentRevision: 'open-intent:1',
        });
        const { openFlow } = createOpenFlowHarness({openSurface});

        await expect(openFlow.openFile({
            kind: 'pdf',
            originalPath,
            workingPath: '/tmp/constrained-cached-working.pdf',
        })).resolves.toMatchObject({status: 'opened'});

        expect(mocks.documentFiles.getPdfOpeningGeometry).not.toHaveBeenCalled();
        expect(openSurface.snapshot.value.openingPageGeometry).toEqual(cachedGeometry);
        invalidateTrustedPdfOpenGeometry(originalPath, 1);
    });

    it('caches geometry that resolves after its open surface was superseded', async () => {
        const originalPath = '/documents/late.pdf';
        const openSurface = createDocumentOpenSurfaceSession();
        openSurface.begin({
            documentId: originalPath,
            documentRevision: 'open-intent:1',
        });
        const geometryGate = Promise.withResolvers<{
            pageNumber: 1;
            pageCount: number;
            width: number;
            height: number;
            rotation: 0;
            size: number;
            modifiedAt: number;
        }>();
        mocks.documentFiles.getPdfOpeningGeometry.mockReturnValue(geometryGate.promise);
        mocks.documentFiles.statFile.mockImplementation(async (path: string) => path === originalPath
            ? {
                size: 5_000,
                modifiedAt: 6_000,
            }
            : {size: PDF_BYTES.byteLength});
        const { openFlow } = createOpenFlowHarness({openSurface});

        await expect(openFlow.openFile({
            kind: 'pdf',
            originalPath,
            workingPath: '/tmp/late-working.pdf',
        })).resolves.toMatchObject({status: 'opened'});
        const supersededGeneration = openSurface.supersede();
        expect(supersededGeneration).not.toBeNull();

        geometryGate.resolve({
            pageNumber: 1,
            pageCount: 5,
            width: 620,
            height: 880,
            rotation: 0,
            size: 5_000,
            modifiedAt: 6_000,
        });
        await vi.waitFor(() => {
            expect(readPrevalidatedTrustedPdfOpenGeometry(originalPath, 1)).toMatchObject({
                width: 620,
                height: 880,
            });
        });
        expect(openSurface.snapshot.value.openingPageGeometry).toBeNull();
        invalidateTrustedPdfOpenGeometry(originalPath, 1);
    });
});
