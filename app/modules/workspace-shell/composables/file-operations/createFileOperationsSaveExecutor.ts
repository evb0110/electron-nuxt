import type { TPdfSaveMode } from '@app/types/pdfContracts';
import type { IPdfPersistResult } from '@app/types/pdfUi';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { IPdfOptimizeOptions } from '@contracts/electronApiDocuments';
import type { INativePdfMutationProjection } from '@app/modules/pdf-viewer/public';
import { BrowserLogger } from '@app/utils/browserLogger';
import { toPdfDateString } from '@app/utils/pdfDate';
import type { IFileOperationsSaveContext } from '@app/modules/workspace-shell/composables/file-operations/createFileOperationsSaveContext';
import type { ISaveStateSnapshot } from '@app/modules/workspace-shell/composables/file-operations/createFileOperationsSaveCompletion';
import { persistNativePdfMutationProjection } from '@app/modules/workspace-shell/composables/file-operations/persistNativePdfMutationProjection';
import type { IPostSaveReloadWaiter } from '@app/modules/workspace-shell/composables/file-operations/postSaveReload';
import type {
    IFileOperationsSavePdfPorts,
    IFileOperationsSavePersistencePorts,
    IFileOperationsSaveStatePorts,
    IFileOperationsSaveViewerPorts,
} from '@app/modules/workspace-shell/composables/file-operations/saveRolePorts';

const RENDERER_SERIALIZED_SAVE_MAX_WORKING_COPY_BYTES = 64 * 1024 * 1024;

type TSaveFlowMode = 'save' | 'save_as';

export interface IPersistSerializedOptions {
    saveMode: TPdfSaveMode;
    preserveLoadedSource?: boolean;
    expectedWorkingPath?: TDocumentRef | null;
    expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
    optimizeLossless?: boolean;
    changedObjectRefs?: string[];
}

export interface IFileOperationsSaveExecutionConfig {
    mode: TSaveFlowMode;
    saveMode: TPdfSaveMode;
    persistSerialized: (
        data: Uint8Array,
        opts: IPersistSerializedOptions,
    ) => Promise<IPdfPersistResult>;
    persistUnserialized: (opts: {
        saveMode: TPdfSaveMode;
        expectedWorkingPath?: TDocumentRef | null;
        expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
    }) => Promise<IPdfPersistResult>;
    persistNativeWorkingCopy?: (opts: {
        saveMode: TPdfSaveMode;
        expectedWorkingPath?: TDocumentRef | null;
        expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
    }) => Promise<IPdfPersistResult>;
    forceRewrite?: boolean;
}

interface IFileOperationsOptimizeCopyExecutionConfig {
    expectedWorkingPath: TDocumentRef | null;
    expectedDocumentRevisionToken: TDocumentRevisionToken | null;
    options: IPdfOptimizeOptions;
    requestId?: string | undefined;
    reloadWaiter: IPostSaveReloadWaiter | null;
}

export interface IFileOperationsSaveExecutorPorts {
    state: Pick<IFileOperationsSaveStatePorts, 'documentIdentity' | 'metadata'>;
    pdf: Pick<IFileOperationsSavePdfPorts, 'source' | 'serialization'>;
    persistence: IFileOperationsSavePersistencePorts;
    viewer: Pick<IFileOperationsSaveViewerPorts, 'markup' | 'shapes'>;
}

export interface IFileOperationsSaveExecutorCompletionServices {
    armPersistedShapeStateAdoption: (shapeStateDirty: boolean) => boolean;
    finalizeSaveReload: (
        reloadWaiter: IPostSaveReloadWaiter | null,
        saveSucceeded: boolean,
        opts?: {
            completeSaveStateOnSuccess?: boolean | undefined;
            markShapeStateSavedOnSuccess?: boolean | undefined;
            preserveLivePdfjsSessionOnSuccess?: boolean | undefined;
            resetAnnotationStorageOnSuccess?: boolean | undefined;
            saveStateSnapshot?: ISaveStateSnapshot | undefined;
        },
    ) => Promise<void>;
    finalizeSuccessfulSave: (
        result: IPdfPersistResult,
        opts?: {
            allowAnnotationSaveStateRefresh?: boolean | undefined;
            allowBookmarksSaveStateRefresh?: boolean | undefined;
            allowPageLabelsSaveStateRefresh?: boolean | undefined;
            completeSaveState?: boolean | undefined;
            markShapeStateSaved?: boolean | undefined;
            preserveLivePdfjsSession?: boolean | undefined;
            resetAnnotationStorage?: boolean | undefined;
            saveStateSnapshot?: ISaveStateSnapshot | undefined;
        },
    ) => boolean;
    primePersistedShapeStateForSave: (
        data: Uint8Array,
        shapeStateDirty: boolean,
    ) => Promise<unknown>;
    refreshAnnotationSaveStateSnapshot: (
        snapshot: ISaveStateSnapshot | undefined,
    ) => ISaveStateSnapshot | undefined;
    restorePreparedShapeState: (snapshot: unknown) => Promise<void>;
}

export interface IFileOperationsSaveExecutorServices {
    clearSaveIndicator: (mode: TSaveFlowMode) => void;
    completion: IFileOperationsSaveExecutorCompletionServices;
    timedSavePhase: <T>(
        phase: string,
        operation: () => Promise<T>,
        describeResult?: (result: T) => Record<string, unknown>,
    ) => Promise<T>;
    trackSaveCompleted: (
        mode: TSaveFlowMode,
        persisted: IPdfPersistResult,
        serializedChanges: boolean,
    ) => void;
}

export function createFileOperationsSaveExecutor(
    ports: IFileOperationsSaveExecutorPorts,
    services: IFileOperationsSaveExecutorServices,
) {
    const {
        state,
        pdf,
        persistence,
    } = ports;
    const { completion } = services;

    async function validateWorkingCopySnapshot(saveMode: TPdfSaveMode) {
        const path = state.documentIdentity.workingCopyPath.value;
        if (!path) {
            return null;
        }

        const validation = await services.timedSavePhase(
            'validate-pdf-path',
            () => persistence.file.validatePdfPath(path),
            result => ({
                saveMode,
                isValid: result.isValid,
                warningCount: result.warnings.length,
                errorCount: result.errors.length,
            }),
        );
        if (!validation.isValid) {
            BrowserLogger.warn('workspace', 'Save aborted because PDF validation failed', {
                errors: validation.errors,
                warnings: validation.warnings,
            });
            return null;
        }
        if (state.documentIdentity.workingCopyPath.value !== path) {
            BrowserLogger.debug('workspace', 'Skipped stale PDF validation result', {
                validatedPath: path,
                currentWorkingPath: state.documentIdentity.workingCopyPath.value,
                saveMode,
            });
            return null;
        }

        return {
            finalBytes: new Uint8Array(),
            saveMode,
            warnings: validation.warnings,
            validation,
            workingPath: path,
        };
    }

    function hasNativePdfMutationCapability() {
        return Boolean(persistence.nativeMutations?.trySavePdfNativeMutations)
            || Boolean(persistence.nativeMutations?.trySaveEmbeddedNoteTextUpdates);
    }

    function canPersistNativeMetadataMutations() {
        return Boolean(persistence.nativeMutations?.trySavePdfNativeMutations);
    }

    function buildSaveTransactionRequest(
        config: IFileOperationsSaveExecutionConfig,
        context: IFileOperationsSaveContext,
        options: {
            allowNativeMutationPlan: boolean;
            planOnly?: boolean;
        },
    ) {
        return {
            mode: 'persist' as const,
            saveMode: config.saveMode,
            saveFlowMode: config.mode,
            forcePdfjsMaterialize: context.savePlan.pdfjsSourceMaterialization.required,
            includeManagedShapes: context.savePlan.pdfjsSourceMaterialization.includeManagedShapesForLiveSource,
            rewriteShapeState: context.shapeStateDirty,
            forceRewrite: config.forceRewrite === true,
            ...(options.planOnly !== undefined ? {planOnly: options.planOnly} : {}),
            dirtyState: {
                annotationDirty: context.dirtyState.annotationDirty,
                hasAnnotationChanges: context.dirtyState.annotationChanges,
                hasLivePdfJsAnnotationChanges: context.dirtyState.livePdfJsAnnotations,
                savedPdfjsAnnotationBaselineDirty: context.dirtyState.savedPdfjsAnnotationBaseline,
                shapeStateDirty: context.shapeStateDirty,
            },
            nativeCapabilities: {
                hasNativePdfMutationCapability: options.allowNativeMutationPlan && hasNativePdfMutationCapability(),
                canPersistNativeMetadataMutations: options.allowNativeMutationPlan && canPersistNativeMetadataMutations(),
            },
            documentStructure: {
                pageLabelsDirty: context.dirtyState.pageLabels,
                pageLabelRanges: state.metadata.pageLabelRanges?.value ?? [],
                bookmarksDirty: context.dirtyState.bookmarks,
                bookmarkItems: state.metadata.bookmarkItems?.value ?? [],
                untitledBookmarkLabel: state.metadata.untitledBookmarkLabel ?? '',
                totalPages: state.metadata.totalPages?.value ?? pdf.source.pdfDocument.value?.numPages ?? 0,
            },
            source: {
                getSourcePdfData: pdf.source.getSourcePdfData,
                serializePdfForSave: pdf.serialization.serializePdfForSave,
            },
            serializeResult: options.planOnly !== true,
        };
    }

    async function runSaveTransactionForContext(
        config: IFileOperationsSaveExecutionConfig,
        context: IFileOperationsSaveContext,
        options: {
            allowNativeMutationPlan: boolean;
            planOnly?: boolean;
        },
    ) {
        return pdf.source.runSaveTransaction(buildSaveTransactionRequest(config, context, options));
    }

    function resolveExpectedWorkingPathForPersistence(
        initialWorkingPath: TDocumentRef | null,
        initialOriginalPath: TDocumentRef | null,
    ) {
        if (state.documentIdentity.originalPath.value !== initialOriginalPath) {
            BrowserLogger.debug('workspace', 'Skipped stale serialized PDF persistence after save target changed', {
                initialOriginalPath,
                currentOriginalPath: state.documentIdentity.originalPath.value,
                initialWorkingPath,
                currentWorkingPath: state.documentIdentity.workingCopyPath.value,
            });
            return null;
        }
        if (!initialWorkingPath || state.documentIdentity.workingCopyPath.value !== initialWorkingPath) {
            BrowserLogger.debug('workspace', 'Skipped stale serialized PDF persistence after working copy changed', {
                initialOriginalPath,
                currentOriginalPath: state.documentIdentity.originalPath.value,
                initialWorkingPath,
                currentWorkingPath: state.documentIdentity.workingCopyPath.value,
            });
            return null;
        }

        return initialWorkingPath;
    }

    async function persistSerializedSaveResult(
        saveResult: {
            finalBytes: Uint8Array;
            saveMode: TPdfSaveMode;
            changedObjectRefs?: readonly string[];
        },
        shapeStateDirty: boolean,
        reloadWaiter: IPostSaveReloadWaiter | null,
        mode: TSaveFlowMode,
        persist: (
            data: Uint8Array,
            opts: IPersistSerializedOptions,
        ) => Promise<IPdfPersistResult>,
        preserveLoadedSource: boolean,
        expectedWorkingPath: TDocumentRef | null = null,
        expectedDocumentRevisionToken: TDocumentRevisionToken | null = null,
        saveStateSnapshot?: ISaveStateSnapshot,
        onPersistenceSucceededBeforeCompletion?: (
            saveStateSnapshot: ISaveStateSnapshot | undefined,
        ) => ISaveStateSnapshot | undefined,
    ) {
        let preparedShapeStateSnapshot: unknown = null;
        try {
            preparedShapeStateSnapshot = await completion.primePersistedShapeStateForSave(
                saveResult.finalBytes,
                shapeStateDirty,
            );
            completion.armPersistedShapeStateAdoption(shapeStateDirty);
            const persisted = await services.timedSavePhase(
                `persist-${mode}`,
                () => persist(saveResult.finalBytes, {
                    saveMode: saveResult.saveMode,
                    preserveLoadedSource,
                    expectedWorkingPath,
                    expectedDocumentRevisionToken,
                    ...(saveResult.changedObjectRefs?.length
                        ? {changedObjectRefs: [...saveResult.changedObjectRefs]}
                        : {}),
                }),
                result => ({
                    bytes: saveResult.finalBytes.byteLength,
                    saveMode: saveResult.saveMode,
                    preserveLoadedSource,
                    success: result.success,
                    didSaveAs: result.didSaveAs,
                }),
            );
            const completionSaveStateSnapshot = persisted.success
                ? onPersistenceSucceededBeforeCompletion?.(saveStateSnapshot) ?? saveStateSnapshot
                : saveStateSnapshot;
            if (completion.finalizeSuccessfulSave(persisted, {
                completeSaveState: !reloadWaiter,
                markShapeStateSaved: !reloadWaiter,
                preserveLivePdfjsSession: preserveLoadedSource && !reloadWaiter,
                saveStateSnapshot: completionSaveStateSnapshot,
            })) {
                preparedShapeStateSnapshot = null;
                services.trackSaveCompleted(mode, persisted, true);
                return true;
            }
            return false;
        } finally {
            await completion.restorePreparedShapeState(preparedShapeStateSnapshot);
        }
    }

    async function saveUnserializedWorkingCopy(
        saveMode: TPdfSaveMode,
        shapeStateDirty: boolean,
        reloadWaiter: IPostSaveReloadWaiter | null,
        mode: TSaveFlowMode,
        persist: (opts: {
            saveMode: TPdfSaveMode;
            expectedWorkingPath?: TDocumentRef | null;
            expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
        }) => Promise<IPdfPersistResult>,
        expectedWorkingPath: TDocumentRef | null,
        expectedDocumentRevisionToken: TDocumentRevisionToken | null,
        saveStateSnapshot?: ISaveStateSnapshot,
    ) {
        const saveResult = await validateWorkingCopySnapshot(saveMode);
        if (!saveResult) {
            return false;
        }
        if (saveResult.workingPath !== expectedWorkingPath) {
            BrowserLogger.debug('workspace', 'Skipped stale working-copy persistence after validation', {
                expectedWorkingPath,
                validatedPath: saveResult.workingPath,
                currentWorkingPath: state.documentIdentity.workingCopyPath.value,
                saveMode,
            });
            return false;
        }

        completion.armPersistedShapeStateAdoption(shapeStateDirty);
        const persisted = await services.timedSavePhase(
            `persist-${mode}-working-copy`,
            () => persist({
                saveMode: saveResult.saveMode,
                expectedWorkingPath,
                expectedDocumentRevisionToken,
            }),
            result => ({
                saveMode: saveResult.saveMode,
                success: result.success,
                didSaveAs: result.didSaveAs,
            }),
        );
        if (!completion.finalizeSuccessfulSave(persisted, {
            completeSaveState: !reloadWaiter,
            markShapeStateSaved: !reloadWaiter,
            resetAnnotationStorage: false,
            saveStateSnapshot,
        })) {
            return false;
        }

        services.trackSaveCompleted(mode, persisted, false);
        return true;
    }

    async function saveNativeWorkingCopy(
        saveMode: TPdfSaveMode,
        reloadWaiter: IPostSaveReloadWaiter | null,
        mode: TSaveFlowMode,
        persist: (opts: {
            saveMode: TPdfSaveMode;
            expectedWorkingPath?: TDocumentRef | null;
            expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
        }) => Promise<IPdfPersistResult>,
        expectedWorkingPath: TDocumentRef | null,
        expectedDocumentRevisionToken: TDocumentRevisionToken | null,
        saveStateSnapshot?: ISaveStateSnapshot,
    ) {
        if (!expectedWorkingPath || state.documentIdentity.workingCopyPath.value !== expectedWorkingPath) {
            BrowserLogger.debug('workspace', 'Skipped stale native working-copy persistence before native write', {
                expectedWorkingPath,
                currentWorkingPath: state.documentIdentity.workingCopyPath.value,
                saveMode,
            });
            return false;
        }

        const persisted = await services.timedSavePhase(
            `persist-${mode}-native-working-copy`,
            () => persist({
                saveMode,
                expectedWorkingPath,
                expectedDocumentRevisionToken,
            }),
            result => ({
                saveMode,
                success: result.success,
                didSaveAs: result.didSaveAs,
            }),
        );
        if (!completion.finalizeSuccessfulSave(persisted, {
            completeSaveState: !reloadWaiter,
            markShapeStateSaved: !reloadWaiter,
            resetAnnotationStorage: false,
            saveStateSnapshot,
        })) {
            return false;
        }

        services.trackSaveCompleted(mode, persisted, false);
        return true;
    }

    async function runSerializedSaveFlow(
        saveResult: {
            finalBytes: Uint8Array;
            saveMode: TPdfSaveMode;
        } | null,
        shapeStateDirty: boolean,
        reloadWaiter: IPostSaveReloadWaiter | null,
        mode: TSaveFlowMode,
        persist: (
            data: Uint8Array,
            opts: IPersistSerializedOptions,
        ) => Promise<IPdfPersistResult>,
        preserveLoadedSource = false,
        expectedWorkingPath: TDocumentRef | null,
        expectedDocumentRevisionToken: TDocumentRevisionToken | null,
        saveStateSnapshot: ISaveStateSnapshot,
        onPersistenceSettled?: () => void,
        onPersistenceSucceededBeforeCompletion?: (
            saveStateSnapshot: ISaveStateSnapshot | undefined,
        ) => ISaveStateSnapshot | undefined,
    ) {
        const completionSaveStateSnapshot = preserveLoadedSource && !reloadWaiter
            ? completion.refreshAnnotationSaveStateSnapshot(saveStateSnapshot)
            : saveStateSnapshot;
        const saveSucceeded = saveResult
            ? await persistSerializedSaveResult(
                saveResult,
                shapeStateDirty,
                reloadWaiter,
                mode,
                persist,
                preserveLoadedSource,
                expectedWorkingPath,
                expectedDocumentRevisionToken,
                completionSaveStateSnapshot,
                onPersistenceSucceededBeforeCompletion,
            )
            : false;
        onPersistenceSettled?.();
        await completion.finalizeSaveReload(reloadWaiter, saveSucceeded, {
            completeSaveStateOnSuccess: Boolean(reloadWaiter),
            markShapeStateSavedOnSuccess: Boolean(reloadWaiter),
            saveStateSnapshot,
        });
        return saveSucceeded;
    }

    async function executeWorkingCopySave(
        config: IFileOperationsSaveExecutionConfig,
        context: IFileOperationsSaveContext,
    ) {
        const saveSucceeded = await saveUnserializedWorkingCopy(
            config.saveMode,
            context.shapeStateDirty,
            context.reloadWaiter.current,
            config.mode,
            config.persistUnserialized,
            context.savePlan.staleTargetProtection.expectedWorkingPath,
            context.savePlan.staleTargetProtection.expectedDocumentRevisionToken,
            context.saveStateSnapshot,
        );
        services.clearSaveIndicator(config.mode);
        await completion.finalizeSaveReload(context.reloadWaiter.current, saveSucceeded, {
            completeSaveStateOnSuccess: Boolean(context.reloadWaiter.current),
            markShapeStateSavedOnSuccess: Boolean(context.reloadWaiter.current),
            resetAnnotationStorageOnSuccess: false,
            saveStateSnapshot: context.saveStateSnapshot,
        });
        context.reloadWaiter.markFinalized();
        return saveSucceeded;
    }

    async function executeNativeWorkingCopySave(
        config: IFileOperationsSaveExecutionConfig,
        context: IFileOperationsSaveContext,
    ) {
        if (!config.persistNativeWorkingCopy) {
            return false;
        }

        const saveSucceeded = await saveNativeWorkingCopy(
            config.saveMode,
            context.reloadWaiter.current,
            config.mode,
            config.persistNativeWorkingCopy,
            context.savePlan.staleTargetProtection.expectedWorkingPath,
            context.savePlan.staleTargetProtection.expectedDocumentRevisionToken,
            context.saveStateSnapshot,
        );
        services.clearSaveIndicator(config.mode);
        await completion.finalizeSaveReload(context.reloadWaiter.current, saveSucceeded, {
            completeSaveStateOnSuccess: Boolean(context.reloadWaiter.current),
            markShapeStateSavedOnSuccess: Boolean(context.reloadWaiter.current),
            resetAnnotationStorageOnSuccess: false,
            saveStateSnapshot: context.saveStateSnapshot,
        });
        context.reloadWaiter.markFinalized();
        return saveSucceeded;
    }

    async function persistNativeMutationProjectionForContext(
        config: IFileOperationsSaveExecutionConfig,
        context: IFileOperationsSaveContext,
        nativeMutationProjection: INativePdfMutationProjection,
        verifyPathBeforeExpose?: (path: TDocumentRef, knownSize: number) => Promise<void>,
        assertBeforeExpose?: () => Promise<void> | void,
    ) {
        const persistenceExpectedWorkingPath = resolveExpectedWorkingPathForPersistence(
            context.savePlan.staleTargetProtection.expectedWorkingPath,
            context.savePlan.staleTargetProtection.expectedOriginalPath,
        );
        if (!persistenceExpectedWorkingPath) {
            BrowserLogger.diagnostic('workspace', 'Skipped native PDF mutation persistence', {reason: 'missing-expected-working-path'});
            return null;
        }

        BrowserLogger.diagnostic('workspace', 'Starting native PDF mutation persistence', () => ({
            phase: nativeMutationProjection.phase,
            updateCount: nativeMutationProjection.noteTextUpdates.length,
            freeTextNoteCount: nativeMutationProjection.freeTextNotes.length,
            deleteCount: nativeMutationProjection.annotationDeletes.length,
            hasMarkupMutations: nativeMutationProjection.hasMarkupMutations,
            hasShapeMutations: nativeMutationProjection.hasShapeMutations,
            hasMetadataMutations: nativeMutationProjection.hasMetadataMutations,
            hasGenericNativePersistence: Boolean(persistence.nativeMutations?.trySavePdfNativeMutations),
            hasLegacyNativeNotePersistence: Boolean(persistence.nativeMutations?.trySaveEmbeddedNoteTextUpdates),
        }));
        const result = await services.timedSavePhase(
            nativeMutationProjection.phase,
            () => persistNativePdfMutationProjection(
                {
                    ...(persistence.nativeMutations?.trySavePdfNativeMutations
                        ? {trySavePdfNativeMutations: persistence.nativeMutations.trySavePdfNativeMutations}
                        : {}),
                    ...(persistence.nativeMutations?.trySaveEmbeddedNoteTextUpdates
                        ? {trySaveEmbeddedNoteTextUpdates: persistence.nativeMutations.trySaveEmbeddedNoteTextUpdates}
                        : {}),
                },
                nativeMutationProjection,
                {
                    saveMode: config.saveMode,
                    preserveLoadedSource: true,
                    expectedWorkingPath: persistenceExpectedWorkingPath,
                    expectedDocumentRevisionToken: context.savePlan.staleTargetProtection.expectedDocumentRevisionToken,
                    modifiedAt: toPdfDateString(new Date()),
                    ...(verifyPathBeforeExpose ? {verifyPathBeforeExpose} : {}),
                    ...(assertBeforeExpose ? {assertBeforeExpose} : {}),
                },
            ),
            result => ({
                applied: result !== null,
                success: result?.success ?? false,
                updateCount: nativeMutationProjection.noteTextUpdates.length,
                freeTextNoteCount: nativeMutationProjection.freeTextNotes.length,
                deleteCount: nativeMutationProjection.annotationDeletes.length,
                pageLabels: nativeMutationProjection.mutations.pageLabels !== undefined,
                bookmarks: nativeMutationProjection.mutations.bookmarks !== undefined,
                shapes: nativeMutationProjection.mutations.shapes?.shapes.length ?? 0,
                markupOverrides: nativeMutationProjection.mutations.markup?.overrides.length ?? 0,
                markupHints: nativeMutationProjection.mutations.markup?.hints.length ?? 0,
                preserveLoadedSource: true,
            }),
        );
        BrowserLogger.diagnostic('workspace', 'Completed native PDF mutation persistence', () => ({
            returnedResult: result !== null,
            success: result?.success ?? false,
        }));
        return result;
    }

    async function prepareNativeShapeSaveCompletion(nativeMutationProjection: INativePdfMutationProjection) {
        let canMarkShapeStateSaved = !nativeMutationProjection.hasShapeMutations;
        let preparedShapeStateSnapshot: unknown = null;
        if (!nativeMutationProjection.hasShapeMutations) {
            return {
                canMarkShapeStateSaved,
                preparedShapeStateSnapshot,
            };
        }

        const savedNativeBytes = await services.timedSavePhase(
            'read-native-shape-saved-bytes',
            pdf.source.getSourcePdfData,
            result => ({bytes: result?.byteLength ?? null}),
        );
        if (savedNativeBytes) {
            preparedShapeStateSnapshot = await completion.primePersistedShapeStateForSave(
                savedNativeBytes,
                true,
            );
            canMarkShapeStateSaved = Boolean(preparedShapeStateSnapshot);
        }
        return {
            canMarkShapeStateSaved,
            preparedShapeStateSnapshot,
        };
    }

    async function finalizeNativeMutationSave(
        config: IFileOperationsSaveExecutionConfig,
        context: IFileOperationsSaveContext,
        nativeMutationProjection: INativePdfMutationProjection,
        persisted: IPdfPersistResult,
        canMarkShapeStateSaved: boolean,
    ) {
        const hasNativeAnnotationMutations = nativeMutationProjection.noteTextUpdates.length > 0
            || nativeMutationProjection.freeTextNotes.length > 0
            || nativeMutationProjection.annotationDeletes.length > 0
            || nativeMutationProjection.hasMarkupMutations
            || nativeMutationProjection.hasShapeMutations;
        const hasNativeBookmarkMutations = nativeMutationProjection.mutations.bookmarks !== undefined;
        const hasNativePageLabelMutations = nativeMutationProjection.mutations.pageLabels !== undefined;
        completion.armPersistedShapeStateAdoption(nativeMutationProjection.hasShapeMutations && canMarkShapeStateSaved);
        context.reloadWaiter.cancel();
        services.clearSaveIndicator(config.mode);
        const saveSucceeded = completion.finalizeSuccessfulSave(persisted, {
            completeSaveState: true,
            allowAnnotationSaveStateRefresh: hasNativeAnnotationMutations,
            allowBookmarksSaveStateRefresh: hasNativeBookmarkMutations,
            allowPageLabelsSaveStateRefresh: hasNativePageLabelMutations,
            markShapeStateSaved: canMarkShapeStateSaved,
            preserveLivePdfjsSession: true,
            saveStateSnapshot: context.saveStateSnapshot,
        });
        if (saveSucceeded) {
            services.trackSaveCompleted(config.mode, persisted, true);
        }
        await completion.finalizeSaveReload(context.reloadWaiter.current, saveSucceeded, {
            completeSaveStateOnSuccess: false,
            markShapeStateSavedOnSuccess: false,
            preserveLivePdfjsSessionOnSuccess: false,
        });
        context.reloadWaiter.markFinalized();
        return saveSucceeded;
    }

    async function executeNativeMutationSave(
        config: IFileOperationsSaveExecutionConfig,
        context: IFileOperationsSaveContext,
    ) {
        const saveTransaction = await runSaveTransactionForContext(
            config,
            context,
            {
                allowNativeMutationPlan: true,
                planOnly: true,
            },
        );
        BrowserLogger.diagnostic('workspace', 'Completed native PDF mutation projection probe', () => ({
            source: saveTransaction.source,
            hasProjection: Boolean(saveTransaction.nativeMutationProjection),
            annotationSavePlan: saveTransaction.annotationSavePlan,
        }));
        const nativeMutationProjection = saveTransaction.nativeMutationProjection;
        if (!nativeMutationProjection) {
            return {status: 'fall-through' as const};
        }

        let preparedShapeStateSnapshot: unknown = null;
        try {
            const persisted = await persistNativeMutationProjectionForContext(
                config,
                context,
                nativeMutationProjection,
                saveTransaction.verifyAnnotationSavePath,
                saveTransaction.assertAnnotationSaveCurrent,
            );
            if (!persisted) {
                return {status: 'fall-through' as const};
            }
            const prepared = await prepareNativeShapeSaveCompletion(nativeMutationProjection);
            preparedShapeStateSnapshot = prepared.preparedShapeStateSnapshot;
            const saveSucceeded = await finalizeNativeMutationSave(
                config,
                context,
                nativeMutationProjection,
                persisted,
                prepared.canMarkShapeStateSaved,
            );
            if (saveSucceeded) {
                saveTransaction.commitAnnotationSave?.();
                preparedShapeStateSnapshot = null;
            }
            return {
                status: 'completed' as const,
                saveSucceeded,
            };
        } finally {
            await completion.restorePreparedShapeState(preparedShapeStateSnapshot);
        }
    }

    function formatStorageSize(bytes: number) {
        if (!Number.isFinite(bytes) || bytes < 0) {
            return `${bytes} bytes`;
        }
        const mib = bytes / (1024 * 1024);
        if (mib < 1024) {
            return `${Math.round(mib * 10) / 10} MiB`;
        }
        const gib = mib / 1024;
        return `${Math.round(gib * 10) / 10} GiB`;
    }

    async function assertRendererSerializedSaveAllowed(context: IFileOperationsSaveContext) {
        const expectedWorkingPath = context.savePlan.staleTargetProtection.expectedWorkingPath;
        const getWorkingCopySize = persistence.nativeWorkingCopy?.getWorkingCopySize;
        if (
            !context.savePlan.rendererFullPdfSerialization.requiresLargeFileGuard
            || !getWorkingCopySize
            || !expectedWorkingPath
        ) {
            return;
        }

        const workingCopySize = await services.timedSavePhase(
            'stat-working-copy-for-serialization',
            () => getWorkingCopySize(expectedWorkingPath),
            result => ({
                bytes: result,
                maxBytes: RENDERER_SERIALIZED_SAVE_MAX_WORKING_COPY_BYTES,
            }),
        );
        if (
            typeof workingCopySize !== 'number'
            || workingCopySize <= RENDERER_SERIALIZED_SAVE_MAX_WORKING_COPY_BYTES
        ) {
            return;
        }

        throw new Error(
            'Large PDF save requires a native save path; renderer full-PDF serialization is disabled for files '
            + `above ${formatStorageSize(RENDERER_SERIALIZED_SAVE_MAX_WORKING_COPY_BYTES)} `
            + `(working copy is ${formatStorageSize(workingCopySize)}).`,
        );
    }

    async function executeSerializedSave(
        config: IFileOperationsSaveExecutionConfig,
        context: IFileOperationsSaveContext,
    ) {
        await assertRendererSerializedSaveAllowed(context);
        const saveTransaction = await runSaveTransactionForContext(
            config,
            context,
            {allowNativeMutationPlan: false},
        );
        const finalBytes = saveTransaction.serializedResult?.finalBytes
            ?? saveTransaction.serializedBytes
            ?? saveTransaction.baseBytes;
        const saveResult = finalBytes
            ? {
                finalBytes,
                saveMode: saveTransaction.serializedResult?.saveMode ?? config.saveMode,
                ...(saveTransaction.serializedResult?.changedObjectRefs?.length
                    ? {changedObjectRefs: saveTransaction.serializedResult.changedObjectRefs}
                    : {}),
            }
            : null;
        const persistenceExpectedWorkingPath = resolveExpectedWorkingPathForPersistence(
            context.savePlan.staleTargetProtection.expectedWorkingPath,
            context.savePlan.staleTargetProtection.expectedOriginalPath,
        );
        let saveSucceeded = false;
        if (persistenceExpectedWorkingPath) {
            // Semantic verification belongs to the same immutable frontier as
            // serialization and must finish before the utility process exposes
            // the staged file through its atomic replace.
            if (saveResult) {
                await saveTransaction.verifyAnnotationSave?.(saveResult.finalBytes);
            }
            await saveTransaction.assertAnnotationSaveCurrent?.();
            saveSucceeded = await runSerializedSaveFlow(
                saveResult,
                context.shapeStateDirty,
                context.reloadWaiter.current,
                config.mode,
                config.persistSerialized,
                context.savePlan.livePdfjsAnnotationSession.canPreserve,
                persistenceExpectedWorkingPath,
                context.savePlan.staleTargetProtection.expectedDocumentRevisionToken,
                context.saveStateSnapshot,
                () => services.clearSaveIndicator(config.mode),
                (saveStateSnapshot) => {
                    const annotationTokenBeforeCommit = completion.refreshAnnotationSaveStateSnapshot(
                        saveStateSnapshot,
                    )?.annotation;
                    const saveFrontierIsStillCurrent = !saveStateSnapshot
                        || Object.is(annotationTokenBeforeCommit, saveStateSnapshot.annotation);
                    saveTransaction.commitAnnotationSave?.();
                    return saveFrontierIsStillCurrent
                        ? completion.refreshAnnotationSaveStateSnapshot(saveStateSnapshot)
                        : saveStateSnapshot;
                },
            );
        } else {
            await completion.finalizeSaveReload(context.reloadWaiter.current, false);
        }
        context.reloadWaiter.markFinalized();
        return saveSucceeded;
    }

    async function executeSelectedSavePath(
        config: IFileOperationsSaveExecutionConfig,
        context: IFileOperationsSaveContext,
    ) {
        const route = context.savePlan.persistenceRoute;
        if (route === 'working-copy') {
            return executeWorkingCopySave(config, context);
        }
        if (route === 'native-working-copy') {
            return executeNativeWorkingCopySave(config, context);
        }
        if (route === 'serialized-rewrite') {
            return executeSerializedSave(config, context);
        }

        const nativeOutcome = await executeNativeMutationSave(config, context);
        if (nativeOutcome.status === 'completed') {
            return nativeOutcome.saveSucceeded;
        }
        return executeSerializedSave(config, context);
    }

    async function executeOptimizeCopySave(config: IFileOperationsOptimizeCopyExecutionConfig) {
        const saveResult = await validateWorkingCopySnapshot('save_as_rewrite');
        if (!saveResult || saveResult.workingPath !== config.expectedWorkingPath) {
            config.reloadWaiter?.cancel();
            return false;
        }

        const persistOptimizeCopy = persistence.nativeWorkingCopy?.optimizeWorkingCopyAsCopy;
        if (!persistOptimizeCopy) {
            return false;
        }

        const persisted = await services.timedSavePhase(
            'persist-optimize-copy-native-working-copy',
            () => persistOptimizeCopy(config.options, config.requestId, {
                saveMode: saveResult.saveMode,
                expectedDocumentRevisionToken: config.expectedDocumentRevisionToken,
                expectedWorkingPath: config.expectedWorkingPath,
            }),
            result => ({
                saveMode: saveResult.saveMode,
                success: result.success,
                didSaveAs: result.didSaveAs,
            }),
        );
        const saveSucceeded = completion.finalizeSuccessfulSave(persisted, {
            completeSaveState: !config.reloadWaiter,
            markShapeStateSaved: !config.reloadWaiter,
            resetAnnotationStorage: false,
        });
        await completion.finalizeSaveReload(config.reloadWaiter, saveSucceeded, {
            completeSaveStateOnSuccess: Boolean(config.reloadWaiter),
            markShapeStateSavedOnSuccess: Boolean(config.reloadWaiter),
            resetAnnotationStorageOnSuccess: false,
        });
        if (saveSucceeded) {
            services.trackSaveCompleted('save_as', persisted, false);
        }
        return saveSucceeded;
    }

    return {
        executeOptimizeCopySave,
        executeSelectedSavePath,
        hasNativePdfMutationCapability,
    };
}
