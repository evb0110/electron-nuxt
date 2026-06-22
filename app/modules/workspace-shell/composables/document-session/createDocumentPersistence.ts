import type {
    IPdfPersistResult,
    TPdfSaveMode,
} from '@app/types/pdf';
import type { TTranslateFn } from '@i18n-app';
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IPdfNativeAnnotationDelete,
    IPdfNativeFreeTextNote,
    IPdfNativeMutationSet,
    IPdfNoteTextUpdate,
} from '@contracts/electronApiDocuments';
import type { IDocumentSessionState } from '@app/modules/workspace-shell/composables/document-session/createDocumentSessionState';
import type { IPdfLoadedState } from '@app/modules/workspace-shell/composables/document-session/createDocumentHistory';
import { createFailedPdfPersistResult } from '@app/services/pdf-file/createFailedPdfPersistResult';
import { createPdfPersistResult } from '@app/services/pdf-file/createPdfPersistResult';
import { savePdfBytesAs } from '@app/services/pdf-file/savePdfBytesAs';
import { savePdfBytesToWorkingCopy } from '@app/services/pdf-file/savePdfBytesToWorkingCopy';
import { BrowserLogger } from '@app/utils/browserLogger';
import { readDocumentBytes } from '@app/utils/documentBytes';
import { getErrorMessage } from '@app/utils/error';
import {
    getDocumentsCapability,
    shouldRefreshWorkingCopyAfterSaveAs,
} from '@app/utils/platformDocuments';

interface IPdfPersistPhaseTiming {
    phase: string;
    durationMs: number;
}

interface ICreateDocumentPersistenceDeps {
    deferPdfConformanceProfile: (path: TDocumentRef) => void;
    getHistoryDebugState: () => {
        historyLength: number;
        historyIndex: number;
        historyCleanIndex: number;
    };
    markCurrentHistoryEntryClean: (
        snapshot: Uint8Array | null,
        options?: { recordSnapshotChange?: boolean },
    ) => Promise<void>;
    pushHistorySnapshot: (
        snapshot: Uint8Array,
        options?: { reuseSnapshot?: boolean },
    ) => Promise<boolean>;
    readPdfStateFromPath: (path: TDocumentRef) => Promise<IPdfLoadedState>;
    shouldForceSaveAsForWorkingCopy: (
        saveMode: TPdfSaveMode,
        workingPath: TDocumentRef,
    ) => Promise<boolean>;
    t: TTranslateFn;
    toPdfBlob: (snapshot: Uint8Array) => Blob;
}

const MAX_IN_MEMORY_PDF_BYTES = 64 * 1024 * 1024;

export function createDocumentPersistence(
    state: IDocumentSessionState,
    deps: ICreateDocumentPersistenceDeps,
) {
    async function commitPersistedPdfState(
        snapshotHint?: Uint8Array | null,
        expectedWorkingPath?: TDocumentRef,
        opts?: {
            preserveLoadedSource?: boolean;
            preserveConformanceProfile?: boolean;
        },
    ) {
        const path = expectedWorkingPath ?? state.workingCopyPath.value;
        if (!path) {
            return false;
        }
        if (!state.isActiveWorkingCopy(path)) {
            return false;
        }

        BrowserLogger.debug('workspace', 'Committing persisted PDF state', () => ({
            path,
            hasSnapshotHint: Boolean(snapshotHint),
            snapshotHintBytes: snapshotHint?.byteLength ?? 0,
            isDirty: state.isDirty.value,
            ...deps.getHistoryDebugState(),
        }));

        if (opts?.preserveLoadedSource) {
            if (snapshotHint && snapshotHint.byteLength <= MAX_IN_MEMORY_PDF_BYTES) {
                const snapshot = snapshotHint.slice();
                if (!state.isActiveWorkingCopy(path)) {
                    return false;
                }
                state.pdfData.value = snapshot;
                state.pdfReloadSrc.value = state.pdfSrc.value instanceof Blob
                    ? deps.toPdfBlob(snapshot)
                    : {
                        kind: 'path',
                        path,
                        size: snapshot.byteLength,
                    };
                await deps.markCurrentHistoryEntryClean(snapshot, { recordSnapshotChange: false });
            } else {
                const nextState = await deps.readPdfStateFromPath(path);
                if (!state.isActiveWorkingCopy(path)) {
                    return false;
                }
                state.pdfData.value = nextState.pdfData;
                state.pdfReloadSrc.value = nextState.pdfSrc;
                await deps.markCurrentHistoryEntryClean(nextState.pdfData, { recordSnapshotChange: false });
            }
        } else if (snapshotHint && snapshotHint.byteLength <= MAX_IN_MEMORY_PDF_BYTES) {
            const snapshot = snapshotHint.slice();
            if (!state.isActiveWorkingCopy(path)) {
                return false;
            }
            state.pdfData.value = snapshot;
            state.pdfSrc.value = deps.toPdfBlob(snapshot);
            state.pdfReloadSrc.value = state.pdfSrc.value;
            await deps.markCurrentHistoryEntryClean(snapshot);
        } else {
            const nextState = await deps.readPdfStateFromPath(path);
            if (!state.isActiveWorkingCopy(path)) {
                return false;
            }
            state.pdfData.value = nextState.pdfData;
            state.pdfSrc.value = nextState.pdfSrc;
            state.pdfReloadSrc.value = nextState.pdfSrc;
            await deps.markCurrentHistoryEntryClean(nextState.pdfData);
        }

        if (opts?.preserveConformanceProfile !== true) {
            deps.deferPdfConformanceProfile(path);
        }
        BrowserLogger.debug('workspace', 'Committed persisted PDF state', () => ({
            path,
            isDirty: state.isDirty.value,
            ...deps.getHistoryDebugState(),
        }));
        return true;
    }

    function createPersistResult(
        success: boolean,
        saveMode: TPdfSaveMode,
        didSaveAs: boolean,
        outPath: TDocumentRef | null = success && !didSaveAs ? state.originalPath.value : null,
    ): IPdfPersistResult {
        return createPdfPersistResult(success, saveMode, didSaveAs, outPath);
    }

    function createFailedPersistResult(
        saveMode: TPdfSaveMode,
        didSaveAs: boolean,
    ): IPdfPersistResult {
        return createFailedPdfPersistResult(saveMode, didSaveAs);
    }

    function createStalePersistResult(
        saveMode: TPdfSaveMode,
        didSaveAs: boolean,
    ): IPdfPersistResult {
        return createPersistResult(false, saveMode, didSaveAs, null);
    }

    function roundDurationMs(durationMs: number) {
        return Math.round(durationMs * 10) / 10;
    }

    async function measurePdfPersistPhase<T>(
        phaseTimings: IPdfPersistPhaseTiming[],
        phase: string,
        operation: () => Promise<T>,
    ) {
        const start = performance.now();
        try {
            return await operation();
        } finally {
            phaseTimings.push({
                phase,
                durationMs: roundDurationMs(performance.now() - start),
            });
        }
    }

    async function runPersistOperation(
        saveMode: TPdfSaveMode,
        didSaveAs: boolean,
        operation: (workingPath: TDocumentRef) => Promise<IPdfPersistResult>,
        expectedWorkingPath?: TDocumentRef | null,
    ): Promise<IPdfPersistResult> {
        const workingPath = state.workingCopyPath.value;
        if (!workingPath) {
            return createFailedPersistResult(saveMode, didSaveAs);
        }
        if (
            expectedWorkingPath !== undefined
            && workingPath !== expectedWorkingPath
        ) {
            BrowserLogger.debug('workspace', 'Skipped stale PDF persistence request', {
                expectedWorkingPath,
                currentWorkingPath: workingPath,
                saveMode,
            });
            return createStalePersistResult(saveMode, didSaveAs);
        }

        try {
            return await operation(workingPath);
        } catch (e) {
            state.error.value = e instanceof Error ? e.message : deps.t('errors.file.save');
            return createFailedPersistResult(saveMode, didSaveAs);
        }
    }

    async function persistPdfDataSilently(data: Uint8Array) {
        const expectedWorkingPath = state.workingCopyPath.value;
        const snapshot = data.slice();
        if (expectedWorkingPath) {
            await getDocumentsCapability().writeFile(expectedWorkingPath, snapshot);
            if (!state.isActiveWorkingCopy(expectedWorkingPath)) {
                BrowserLogger.debug('pdf-file', 'Skipped stale silent PDF data persistence', {
                    expectedWorkingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                });
                return false;
            }
        } else if (state.workingCopyPath.value !== null) {
            return false;
        }

        state.pdfData.value = snapshot;
        state.pdfSrc.value = deps.toPdfBlob(snapshot);
        state.pdfReloadSrc.value = state.pdfSrc.value;
        await deps.pushHistorySnapshot(snapshot, { reuseSnapshot: true });

        if (expectedWorkingPath) {
            deps.deferPdfConformanceProfile(expectedWorkingPath);
        }
        return true;
    }

    async function readWorkingCopyBytes() {
        const path = state.workingCopyPath.value;
        if (!path) {
            return null;
        }

        try {
            const bytes = await readDocumentBytes(path);
            return state.isActiveWorkingCopy(path) ? bytes : null;
        } catch (readError) {
            if (!state.isActiveWorkingCopy(path)) {
                return null;
            }
            state.error.value = readError instanceof Error ? readError.message : deps.t('errors.file.save');
            return null;
        }
    }

    async function saveFile(
        data: Uint8Array,
        opts?: {
            saveMode?: TPdfSaveMode;
            preserveLoadedSource?: boolean;
            expectedWorkingPath?: TDocumentRef | null;
        },
    ): Promise<IPdfPersistResult> {
        const requestedSaveMode = opts?.saveMode ?? 'rewrite';
        return runPersistOperation(requestedSaveMode, false, async (workingPath) => {
            const forceSaveAs = await deps.shouldForceSaveAsForWorkingCopy(requestedSaveMode, workingPath);
            if (!state.isActiveWorkingCopy(workingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale PDF save before write', {
                    workingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (forceSaveAs) {
                return saveWorkingCopyAs(data, {
                    saveMode: 'save_as_rewrite',
                    expectedWorkingPath: workingPath,
                });
            }

            const validation = await savePdfBytesToWorkingCopy(workingPath, data);
            if (!state.isActiveWorkingCopy(workingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale PDF save completion', {
                    workingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (!validation.isValid) {
                state.error.value = validation.errors.join('\n') || deps.t('errors.file.save');
                return createFailedPersistResult(requestedSaveMode, false);
            }
            const commitOptions = opts?.preserveLoadedSource
                ? { preserveLoadedSource: true }
                : undefined;
            if (!await commitPersistedPdfState(data, workingPath, commitOptions)) {
                return createStalePersistResult(requestedSaveMode, false);
            }
            state.lastSaveMode.value = requestedSaveMode;
            return createPersistResult(true, requestedSaveMode, false);
        }, opts?.expectedWorkingPath);
    }

    async function saveWorkingCopy(
        opts?: {
            saveMode?: TPdfSaveMode;
            expectedWorkingPath?: TDocumentRef | null;
        },
    ): Promise<IPdfPersistResult> {
        const requestedSaveMode = opts?.saveMode ?? 'rewrite';
        return runPersistOperation(requestedSaveMode, false, async (workingPath) => {
            const forceSaveAs = await deps.shouldForceSaveAsForWorkingCopy(requestedSaveMode, workingPath);
            if (!state.isActiveWorkingCopy(workingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale working-copy save before write', {
                    workingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (forceSaveAs) {
                return saveWorkingCopyAs(undefined, {
                    saveMode: 'save_as_rewrite',
                    expectedWorkingPath: workingPath,
                });
            }

            await getDocumentsCapability().saveFile(workingPath);
            if (!state.isActiveWorkingCopy(workingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale working-copy save completion', {
                    workingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (!await commitPersistedPdfState(undefined, workingPath)) {
                return createStalePersistResult(requestedSaveMode, false);
            }
            state.lastSaveMode.value = requestedSaveMode;
            return createPersistResult(true, requestedSaveMode, false);
        }, opts?.expectedWorkingPath);
    }

    async function repairWorkingCopy(
        opts?: {
            saveMode?: TPdfSaveMode;
            expectedWorkingPath?: TDocumentRef | null;
        },
    ): Promise<IPdfPersistResult> {
        const requestedSaveMode = opts?.saveMode ?? 'rewrite';
        return runPersistOperation(requestedSaveMode, false, async (workingPath) => {
            const forceSaveAs = await deps.shouldForceSaveAsForWorkingCopy(requestedSaveMode, workingPath);
            if (!state.isActiveWorkingCopy(workingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale working-copy repair before write', {
                    workingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (forceSaveAs) {
                return saveWorkingCopyAs(undefined, {
                    saveMode: 'save_as_rewrite',
                    expectedWorkingPath: workingPath,
                });
            }

            const repairPdf = getDocumentsCapability().repairPdf;
            if (!repairPdf) {
                return createFailedPersistResult(requestedSaveMode, false);
            }
            const validation = await repairPdf(workingPath);
            if (!state.isActiveWorkingCopy(workingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale working-copy repair completion', {
                    workingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (!validation.isValid) {
                state.error.value = validation.errors.join('\n') || deps.t('errors.file.save');
                return createFailedPersistResult(requestedSaveMode, false);
            }
            if (!await commitPersistedPdfState(undefined, workingPath)) {
                return createStalePersistResult(requestedSaveMode, false);
            }
            state.lastSaveMode.value = requestedSaveMode;
            return createPersistResult(true, requestedSaveMode, false);
        }, opts?.expectedWorkingPath);
    }

    async function optimizeWorkingCopy(
        opts?: {
            saveMode?: TPdfSaveMode;
            expectedWorkingPath?: TDocumentRef | null;
        },
    ): Promise<IPdfPersistResult> {
        const requestedSaveMode = opts?.saveMode ?? 'rewrite';
        return runPersistOperation(requestedSaveMode, false, async (workingPath) => {
            const forceSaveAs = await deps.shouldForceSaveAsForWorkingCopy(requestedSaveMode, workingPath);
            if (!state.isActiveWorkingCopy(workingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale working-copy optimize before write', {
                    workingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (forceSaveAs) {
                return saveWorkingCopyAs(undefined, {
                    saveMode: 'save_as_rewrite',
                    expectedWorkingPath: workingPath,
                });
            }

            const optimizePdfForInteraction = getDocumentsCapability().optimizePdfForInteraction;
            if (!optimizePdfForInteraction) {
                return createFailedPersistResult(requestedSaveMode, false);
            }
            const validation = await optimizePdfForInteraction(workingPath);
            if (!state.isActiveWorkingCopy(workingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale working-copy optimize completion', {
                    workingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (!validation.isValid) {
                state.error.value = validation.errors.join('\n') || deps.t('errors.file.save');
                return createFailedPersistResult(requestedSaveMode, false);
            }
            if (!await commitPersistedPdfState(undefined, workingPath)) {
                return createStalePersistResult(requestedSaveMode, false);
            }
            state.lastSaveMode.value = requestedSaveMode;
            return createPersistResult(true, requestedSaveMode, false);
        }, opts?.expectedWorkingPath);
    }

    async function trySaveEmbeddedNoteTextUpdates(
        updates: IPdfNoteTextUpdate[],
        opts: {
            saveMode: TPdfSaveMode;
            preserveLoadedSource?: boolean;
            expectedWorkingPath?: TDocumentRef | null;
            modifiedAt: string;
            freeTextNotes?: IPdfNativeFreeTextNote[];
            deletes?: IPdfNativeAnnotationDelete[];
        },
    ): Promise<IPdfPersistResult | null> {
        return trySavePdfNativeMutations({
            ...(updates.length > 0 ? {updates} : {}),
            ...((opts.freeTextNotes?.length ?? 0) > 0 ? {freeTextNotes: opts.freeTextNotes} : {}),
            ...((opts.deletes?.length ?? 0) > 0 ? {deletes: opts.deletes} : {}),
        }, opts);
    }

    async function trySavePdfNativeMutations(
        mutations: IPdfNativeMutationSet,
        opts: {
            saveMode: TPdfSaveMode;
            preserveLoadedSource?: boolean;
            expectedWorkingPath?: TDocumentRef | null;
            modifiedAt: string;
        },
    ): Promise<IPdfPersistResult | null> {
        const documents = getDocumentsCapability();
        const updates = mutations.updates ?? [];
        const freeTextNotes = mutations.freeTextNotes ?? [];
        const deletes = mutations.deletes ?? [];
        const hasPageLabels = mutations.pageLabels !== undefined;
        const hasBookmarks = mutations.bookmarks !== undefined;
        const hasShapes = mutations.shapes !== undefined;
        const hasMarkup = mutations.markup !== undefined;
        const placedImages = mutations.placedImages ?? [];
        const hasPlacedImages = placedImages.length > 0;
        if (
            freeTextNotes.length === 0
            && updates.length === 0
            && deletes.length === 0
            && !hasPageLabels
            && !hasBookmarks
            && !hasShapes
            && !hasMarkup
            && !hasPlacedImages
        ) {
            return null;
        }
        const canUseGenericNativeMutations = typeof documents.savePdfNativeMutations === 'function';
        const canUseLegacyNativeNoteText = (
            !hasPageLabels
            && !hasBookmarks
            && !hasShapes
            && !hasMarkup
            && !hasPlacedImages
            && freeTextNotes.length === 0
            && deletes.length === 0
            && updates.length > 0
            && typeof documents.savePdfNoteTextUpdates === 'function'
        );
        const canUseLegacyNativeNoteChanges = (
            !hasPageLabels
            && !hasBookmarks
            && !hasShapes
            && !hasMarkup
            && !hasPlacedImages
            && (freeTextNotes.length > 0 || deletes.length > 0)
            && typeof documents.savePdfNoteChanges === 'function'
        );
        if (!canUseGenericNativeMutations && !canUseLegacyNativeNoteText && !canUseLegacyNativeNoteChanges) {
            return null;
        }

        const requestedSaveMode = opts.saveMode;
        const workingPath = state.workingCopyPath.value;
        const expectedOriginalPath = state.originalPath.value;
        if (!workingPath) {
            return createFailedPersistResult(requestedSaveMode, false);
        }
        if (opts.expectedWorkingPath !== undefined && workingPath !== opts.expectedWorkingPath) {
            BrowserLogger.debug('workspace', 'Skipped stale native note-text save request', {
                expectedWorkingPath: opts.expectedWorkingPath,
                currentWorkingPath: workingPath,
                saveMode: requestedSaveMode,
            });
            return createStalePersistResult(requestedSaveMode, false);
        }

        const phaseTimings: IPdfPersistPhaseTiming[] = [];
        const operationStart = performance.now();
        const logRendererTimings = (status: string, extra?: Record<string, unknown>) => {
            BrowserLogger.debug('workspace', 'Native PDF mutation save renderer timings', {
                status,
                saveMode: requestedSaveMode,
                updateCount: updates.length,
                freeTextNoteCount: freeTextNotes.length,
                deleteCount: deletes.length,
                pageLabels: hasPageLabels,
                bookmarks: hasBookmarks,
                shapes: hasShapes,
                markup: hasMarkup,
                placedImageCount: placedImages.length,
                totalMs: roundDurationMs(performance.now() - operationStart),
                phases: phaseTimings,
                ...extra,
            });
        };

        try {
            const forceSaveAs = await measurePdfPersistPhase(
                phaseTimings,
                'should-force-save-as',
                () => deps.shouldForceSaveAsForWorkingCopy(requestedSaveMode, workingPath),
            );
            if (!state.isActiveWorkingCopy(workingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale native PDF mutation save before write', {
                    workingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
                logRendererTimings('stale-before-write');
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (forceSaveAs) {
                logRendererTimings('force-save-as');
                return null;
            }

            const result = await measurePdfPersistPhase(
                phaseTimings,
                'native-ipc',
                () => {
                    if (canUseGenericNativeMutations) {
                        return documents.savePdfNativeMutations!(workingPath, mutations, opts.modifiedAt);
                    }
                    if (canUseLegacyNativeNoteChanges) {
                        return documents.savePdfNoteChanges!(workingPath, {
                            ...(updates.length > 0 ? {updates} : {}),
                            ...(freeTextNotes.length > 0 ? {freeTextNotes} : {}),
                            ...(deletes.length > 0 ? {deletes} : {}),
                        }, opts.modifiedAt);
                    }
                    return documents.savePdfNoteTextUpdates!(workingPath, updates, opts.modifiedAt);
                },
            );
            if (!result.applied || !result.validation?.isValid) {
                logRendererTimings('not-applied', {validation: result.validation});
                return null;
            }
            if (result.syncError) {
                BrowserLogger.warn('workspace', 'Native PDF mutation committed with a working copy sync warning', {
                    workingPath,
                    syncError: result.syncError,
                });
            }
            const commitWorkingPath = state.workingCopyPath.value;
            if (!commitWorkingPath || state.originalPath.value !== expectedOriginalPath) {
                BrowserLogger.debug('workspace', 'Skipped stale native PDF mutation save completion', {
                    workingPath,
                    expectedOriginalPath,
                    currentOriginalPath: state.originalPath.value,
                    currentWorkingPath: state.workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
                logRendererTimings('stale-after-write');
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (commitWorkingPath !== workingPath) {
                BrowserLogger.debug('workspace', 'Using refreshed working copy after native PDF mutation save', {
                    workingPath,
                    refreshedWorkingPath: commitWorkingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
            }

            const commitOptions = opts.preserveLoadedSource
                ? {
                    preserveLoadedSource: true,
                    preserveConformanceProfile: true,
                }
                : undefined;
            const committed = await measurePdfPersistPhase(
                phaseTimings,
                'commit-persisted-state',
                () => commitPersistedPdfState(undefined, commitWorkingPath, commitOptions),
            );
            if (!committed) {
                logRendererTimings('stale-commit');
                return createStalePersistResult(requestedSaveMode, false);
            }
            state.lastSaveMode.value = requestedSaveMode;
            logRendererTimings('applied');
            return createPersistResult(true, requestedSaveMode, false);
        } catch (saveError) {
            BrowserLogger.debug('workspace', 'Native PDF mutation save unavailable; falling back to serialized PDF save', {
                error: getErrorMessage(saveError),
                updateCount: updates.length,
                freeTextNoteCount: freeTextNotes.length,
                deleteCount: deletes.length,
                pageLabels: hasPageLabels,
                bookmarks: hasBookmarks,
                shapes: hasShapes,
                markup: hasMarkup,
                placedImageCount: placedImages.length,
                saveMode: requestedSaveMode,
                totalMs: roundDurationMs(performance.now() - operationStart),
                phases: phaseTimings,
            });
            return null;
        }
    }

    async function saveWorkingCopyAs(
        data?: Uint8Array,
        opts?: {
            saveMode?: TPdfSaveMode;
            expectedWorkingPath?: TDocumentRef | null;
            optimizeLossless?: boolean;
        },
    ): Promise<IPdfPersistResult> {
        const requestedSaveMode = opts?.saveMode ?? 'save_as_rewrite';
        return runPersistOperation(requestedSaveMode, true, async (workingPath) => {
            const previousWorkingPath = workingPath;
            const saveAsOptions = opts?.optimizeLossless === true
                ? { optimizeLossless: true }
                : undefined;
            const saveAsResult = data
                ? await savePdfBytesAs(workingPath, data, saveAsOptions)
                : {
                    path: saveAsOptions
                        ? await getDocumentsCapability().savePdfAs(workingPath, saveAsOptions)
                        : await getDocumentsCapability().savePdfAs(workingPath),
                    validation: null,
                };
            if (saveAsResult.validation && !saveAsResult.validation.isValid) {
                state.error.value = saveAsResult.validation.errors.join('\n') || deps.t('errors.file.save');
                return createFailedPersistResult(requestedSaveMode, true);
            }
            if (!state.isActiveWorkingCopy(previousWorkingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale Save As completion', {
                    workingPath: previousWorkingPath,
                    currentWorkingPath: state.workingCopyPath.value,
                    savedPath: saveAsResult.path,
                    saveMode: requestedSaveMode,
                });
                return createStalePersistResult(requestedSaveMode, true);
            }
            const savedPath = saveAsResult.path;
            if (savedPath) {
                let savedWorkingPath = previousWorkingPath;
                if (shouldRefreshWorkingCopyAfterSaveAs(savedPath, previousWorkingPath)) {
                    const nextWorkingPath =
                        await getDocumentsCapability().createWorkingCopyFromPath(savedPath);
                    if (!state.isActiveWorkingCopy(previousWorkingPath)) {
                        BrowserLogger.debug('workspace', 'Skipped stale Save As working-copy refresh', {
                            workingPath: previousWorkingPath,
                            currentWorkingPath: state.workingCopyPath.value,
                            nextWorkingPath,
                            savedPath,
                            saveMode: requestedSaveMode,
                        });
                        if (!state.isActiveWorkingCopy(nextWorkingPath)) {
                            void getDocumentsCapability().cleanupFile(nextWorkingPath);
                        }
                        return createStalePersistResult(requestedSaveMode, true);
                    }
                    state.workingCopyPath.value = nextWorkingPath;
                    savedWorkingPath = nextWorkingPath;
                    if (previousWorkingPath !== nextWorkingPath) {
                        try {
                            await getDocumentsCapability().cleanupFile(previousWorkingPath);
                        } catch (cleanupError) {
                            BrowserLogger.warn('workspace', 'Save As succeeded but previous working-copy cleanup failed', {
                                previousWorkingPath,
                                nextWorkingPath,
                                savedPath,
                                error: cleanupError,
                            });
                        }
                    }
                }
                if (!state.isActiveWorkingCopy(savedWorkingPath)) {
                    BrowserLogger.debug('workspace', 'Skipped stale Save As state commit', {
                        workingPath: savedWorkingPath,
                        currentWorkingPath: state.workingCopyPath.value,
                        savedPath,
                        saveMode: requestedSaveMode,
                    });
                    return createStalePersistResult(requestedSaveMode, true);
                }
                state.originalPath.value = savedPath;
                state.requiresSaveAsOnFirstSave.value = false;
                if (!await commitPersistedPdfState(data ?? undefined, savedWorkingPath)) {
                    return createStalePersistResult(requestedSaveMode, true);
                }
                state.lastSaveMode.value = requestedSaveMode;
            }
            return createPersistResult(Boolean(savedPath), requestedSaveMode, true, savedPath);
        }, opts?.expectedWorkingPath);
    }

    return {
        persistPdfDataSilently,
        readWorkingCopyBytes,
        saveFile,
        repairWorkingCopy,
        optimizeWorkingCopy,
        saveWorkingCopy,
        saveWorkingCopyAs,
        trySaveEmbeddedNoteTextUpdates,
        trySavePdfNativeMutations,
    };
}
