import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type {
    IPdfPersistResult,
    TPdfSaveMode,
} from '@app/types/pdf';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IPdfOptimizeOptions } from '@contracts/electronApiDocuments';
import {
    buildNativePdfMutationPlanForSave,
    type INativePdfMutationPlan,
} from '@app/modules/pdf-viewer/public';
import { BrowserLogger } from '@app/utils/browserLogger';
import { toPdfDateString } from '@app/utils/pdfDate';
import type { IFileOperationsSaveContext } from '@app/modules/workspace-shell/composables/file-operations/createFileOperationsSaveContext';
import type { ISaveStateSnapshot } from '@app/modules/workspace-shell/composables/file-operations/createFileOperationsSaveCompletion';
import { persistNativePdfMutationPlan as persistNativePdfMutationPlanRoute } from '@app/modules/workspace-shell/composables/file-operations/persistNativePdfMutationPlan';
import type { IPostSaveReloadWaiter } from '@app/modules/workspace-shell/composables/file-operations/postSaveReload';
import type {
    IFileOperationsSavePdfPorts,
    IFileOperationsSavePersistencePorts,
    IFileOperationsSaveStatePorts,
    IFileOperationsSaveViewerPorts,
} from '@app/modules/workspace-shell/composables/file-operations/saveRolePorts';
import type {
    IBuildSerializedSaveResultOptions,
    ISerializationBasePdfBytesOptions,
} from '@app/modules/workspace-shell/composables/file-operations/createFileOperationsSaveSource';

const RENDERER_SERIALIZED_SAVE_MAX_WORKING_COPY_BYTES = 512 * 1024 * 1024;

type TSaveFlowMode = 'save' | 'save_as';

export interface IPersistSerializedOptions {
    saveMode: TPdfSaveMode;
    preserveLoadedSource?: boolean;
    expectedWorkingPath?: TDocumentRef | null;
    optimizeLossless?: boolean;
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
    }) => Promise<IPdfPersistResult>;
    persistNativeWorkingCopy?: (opts: {
        saveMode: TPdfSaveMode;
        expectedWorkingPath?: TDocumentRef | null;
    }) => Promise<IPdfPersistResult>;
    forceRewrite?: boolean;
}

interface IFileOperationsOptimizeCopyExecutionConfig {
    expectedWorkingPath: TDocumentRef | null;
    options: IPdfOptimizeOptions;
    requestId?: string | undefined;
    reloadWaiter: IPostSaveReloadWaiter | null;
}

export interface IFileOperationsSaveExecutorPorts {
    state: Pick<IFileOperationsSaveStatePorts, 'documentIdentity' | 'metadata'>;
    pdf: Pick<IFileOperationsSavePdfPorts, 'source'>;
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

export interface IFileOperationsSaveExecutorSourceServices {
    buildAnnotationSavePlan: (
        opts?: ISerializationBasePdfBytesOptions,
    ) => {
        route: string;
        reason: string; 
    };
    buildSerializedSaveResult: (
        rawData: Uint8Array,
        pendingTexts: Map<string, string> | null,
        pendingDeletes: IAnnotationCommentSummary[] | null,
        opts?: IBuildSerializedSaveResultOptions,
    ) => Promise<{
        finalBytes: Uint8Array;
        saveMode: TPdfSaveMode;
    } | null>;
    getSerializationBasePdfBytes: (
        opts?: ISerializationBasePdfBytesOptions,
    ) => Promise<Uint8Array | null>;
}

export interface IFileOperationsSaveExecutorServices {
    clearSaveIndicator: (mode: TSaveFlowMode) => void;
    completion: IFileOperationsSaveExecutorCompletionServices;
    source: IFileOperationsSaveExecutorSourceServices;
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
        viewer,
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

    function logNativePdfMutationSkip(
        opts: {
            pendingTexts: Map<string, string> | null;
            pendingDeletes: IAnnotationCommentSummary[] | null;
            shapeStateDirty: boolean;
            forcePdfjsMaterialize: boolean;
            savedPdfjsAnnotationBaselineDirty?: boolean;
            includeManagedShapesForLiveSource: boolean;
            forceRewrite: boolean;
            pageLabelsDirty: boolean;
            bookmarksDirty: boolean;
        },
        event: string,
        reason: string,
        details: Record<string, unknown> = {},
    ) {
        BrowserLogger.debug('workspace', event, () => ({
            reason,
            pendingTexts: opts.pendingTexts?.size ?? 0,
            pendingDeletes: opts.pendingDeletes?.length ?? 0,
            shapeStateDirty: opts.shapeStateDirty,
            forcePdfjsMaterialize: opts.forcePdfjsMaterialize,
            savedPdfjsAnnotationBaselineDirty: opts.savedPdfjsAnnotationBaselineDirty,
            includeManagedShapesForLiveSource: opts.includeManagedShapesForLiveSource,
            forceRewrite: opts.forceRewrite,
            pageLabelsDirty: opts.pageLabelsDirty,
            bookmarksDirty: opts.bookmarksDirty,
            ...details,
        }));
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
        saveStateSnapshot?: ISaveStateSnapshot,
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
                }),
                result => ({
                    bytes: saveResult.finalBytes.byteLength,
                    saveMode: saveResult.saveMode,
                    preserveLoadedSource,
                    success: result.success,
                    didSaveAs: result.didSaveAs,
                }),
            );
            if (completion.finalizeSuccessfulSave(persisted, {
                completeSaveState: !reloadWaiter,
                markShapeStateSaved: !reloadWaiter,
                preserveLivePdfjsSession: preserveLoadedSource && !reloadWaiter,
                saveStateSnapshot,
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

    async function saveSerializedChanges(
        rawData: Uint8Array | null,
        pendingTexts: Map<string, string> | null,
        pendingDeletes: IAnnotationCommentSummary[] | null,
        annotationCommentsSnapshot: IAnnotationCommentSummary[],
        shapeStateDirty: boolean,
        includeManagedShapesForLiveSource: boolean,
        forceRewrite: boolean,
        reloadWaiter: IPostSaveReloadWaiter | null,
        mode: TSaveFlowMode,
        saveMode: TPdfSaveMode,
        persist: (
            data: Uint8Array,
            opts: IPersistSerializedOptions,
        ) => Promise<IPdfPersistResult>,
        preserveLoadedSource = false,
        expectedWorkingPath: TDocumentRef | null = null,
        saveStateSnapshot?: ISaveStateSnapshot,
    ) {
        if (!rawData) {
            return false;
        }

        const saveResult = await services.source.buildSerializedSaveResult(rawData, pendingTexts, pendingDeletes, {
            includeShapes: shapeStateDirty || includeManagedShapesForLiveSource,
            rewriteShapeState: shapeStateDirty,
            forceRewrite,
            saveMode,
            annotationCommentsSnapshot,
        });
        if (!saveResult) {
            return false;
        }
        const completionSaveStateSnapshot = preserveLoadedSource && !reloadWaiter
            ? completion.refreshAnnotationSaveStateSnapshot(saveStateSnapshot)
            : saveStateSnapshot;

        return persistSerializedSaveResult(
            saveResult,
            shapeStateDirty,
            reloadWaiter,
            mode,
            persist,
            preserveLoadedSource,
            expectedWorkingPath,
            completionSaveStateSnapshot,
        );
    }

    async function saveUnserializedWorkingCopy(
        saveMode: TPdfSaveMode,
        shapeStateDirty: boolean,
        reloadWaiter: IPostSaveReloadWaiter | null,
        mode: TSaveFlowMode,
        persist: (opts: {
            saveMode: TPdfSaveMode;
            expectedWorkingPath?: TDocumentRef | null;
        }) => Promise<IPdfPersistResult>,
        expectedWorkingPath: TDocumentRef | null,
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
        }) => Promise<IPdfPersistResult>,
        expectedWorkingPath: TDocumentRef | null,
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
        rawData: Uint8Array | null,
        pendingTexts: Map<string, string> | null,
        pendingDeletes: IAnnotationCommentSummary[] | null,
        annotationCommentsSnapshot: IAnnotationCommentSummary[],
        shapeStateDirty: boolean,
        reloadWaiter: IPostSaveReloadWaiter | null,
        mode: TSaveFlowMode,
        saveMode: TPdfSaveMode,
        persist: (
            data: Uint8Array,
            opts: IPersistSerializedOptions,
        ) => Promise<IPdfPersistResult>,
        preserveLoadedSource = false,
        includeManagedShapesForLiveSource = false,
        forceRewrite = false,
        expectedWorkingPath: TDocumentRef | null,
        saveStateSnapshot: ISaveStateSnapshot,
        onPersistenceSettled?: () => void,
    ) {
        const saveSucceeded = await saveSerializedChanges(
            rawData,
            pendingTexts,
            pendingDeletes,
            annotationCommentsSnapshot,
            shapeStateDirty,
            includeManagedShapesForLiveSource,
            forceRewrite,
            reloadWaiter,
            mode,
            saveMode,
            persist,
            preserveLoadedSource,
            expectedWorkingPath,
            saveStateSnapshot,
        );
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

    function buildNativeMutationPlanForContext(
        config: IFileOperationsSaveExecutionConfig,
        context: IFileOperationsSaveContext,
    ) {
        const annotationWorkDirty = context.dirtyState.annotationDirty
            || (context.dirtyState.annotationChanges && !context.dirtyState.shapes);
        const nativeMutationPlanContext = {
            mode: config.mode,
            pendingTexts: context.pendingTexts,
            pendingDeletes: context.pendingDeletes,
            shapeStateDirty: context.shapeStateDirty,
            forcePdfjsMaterialize: context.savePlan.pdfjsSourceMaterialization.forcePdfjsMaterialize,
            includeManagedShapesForLiveSource: context.savePlan.pdfjsSourceMaterialization.includeManagedShapesForLiveSource,
            forceRewrite: config.forceRewrite === true,
            savedPdfjsAnnotationBaselineDirty: context.dirtyState.savedPdfjsAnnotationBaseline,
            pageLabelsDirty: context.dirtyState.pageLabels,
            bookmarksDirty: context.dirtyState.bookmarks,
        };
        const nativeMutationPlanResult = buildNativePdfMutationPlanForSave({
            ...nativeMutationPlanContext,
            annotationCommentsSnapshot: context.annotationCommentsSnapshot,
            hasNativePdfMutationCapability: hasNativePdfMutationCapability(),
            annotationSavePlan: services.source.buildAnnotationSavePlan({
                pendingTexts: context.pendingTexts,
                pendingDeletes: context.pendingDeletes,
            }),
            annotationDirty: context.dirtyState.annotationDirty,
            hasAnnotationChanges: context.dirtyState.annotationChanges,
            hasLivePdfJsAnnotationChanges: context.dirtyState.livePdfJsAnnotations,
            canPersistNativeMetadataMutations: canPersistNativeMetadataMutations(),
            totalPageCount: state.metadata.totalPages?.value ?? pdf.source.pdfDocument.value?.numPages ?? 0,
            pageLabelRanges: state.metadata.pageLabelRanges?.value ?? null,
            bookmarkItems: state.metadata.bookmarkItems?.value ?? null,
            untitledBookmarkLabel: state.metadata.untitledBookmarkLabel ?? '',
            shapes: context.shapeStateDirty ? viewer.shapes.getAllShapes?.() ?? null : null,
            deletedEmbeddedShapeAnnotationIds: context.shapeStateDirty ? viewer.shapes.getDeletedEmbeddedShapeAnnotationIds?.() ?? [] : [],
            deletedEmbeddedShapeStableKeys: context.shapeStateDirty ? viewer.shapes.getDeletedEmbeddedShapeStableKeys?.() ?? [] : [],
            markupSubtypeOverrides: annotationWorkDirty ? viewer.markup.getMarkupSubtypeOverrides?.() : undefined,
            markupSubtypeHints: annotationWorkDirty ? viewer.markup.getMarkupSubtypeHints?.() ?? [] : [],
        });
        nativeMutationPlanResult.skipEvents.forEach(({
            event,
            reason,
            details,
        }) => {
            logNativePdfMutationSkip(nativeMutationPlanContext, event, reason, details);
        });
        return nativeMutationPlanResult.plan;
    }

    async function persistNativeMutationPlanForContext(
        config: IFileOperationsSaveExecutionConfig,
        context: IFileOperationsSaveContext,
        nativeMutationPlan: INativePdfMutationPlan,
    ) {
        const persistenceExpectedWorkingPath = resolveExpectedWorkingPathForPersistence(
            context.savePlan.staleTargetProtection.expectedWorkingPath,
            context.savePlan.staleTargetProtection.expectedOriginalPath,
        );
        if (!persistenceExpectedWorkingPath) {
            return null;
        }

        return services.timedSavePhase(
            nativeMutationPlan.phase,
            () => persistNativePdfMutationPlanRoute(
                {
                    ...(persistence.nativeMutations?.trySavePdfNativeMutations
                        ? {trySavePdfNativeMutations: persistence.nativeMutations.trySavePdfNativeMutations}
                        : {}),
                    ...(persistence.nativeMutations?.trySaveEmbeddedNoteTextUpdates
                        ? {trySaveEmbeddedNoteTextUpdates: persistence.nativeMutations.trySaveEmbeddedNoteTextUpdates}
                        : {}),
                },
                nativeMutationPlan,
                {
                    saveMode: config.saveMode,
                    preserveLoadedSource: true,
                    expectedWorkingPath: persistenceExpectedWorkingPath,
                    modifiedAt: toPdfDateString(new Date()),
                },
            ),
            result => ({
                applied: result !== null,
                success: result?.success ?? false,
                updateCount: nativeMutationPlan.noteTextUpdates.length,
                freeTextNoteCount: nativeMutationPlan.freeTextNotes.length,
                deleteCount: nativeMutationPlan.annotationDeletes.length,
                pageLabels: nativeMutationPlan.mutations.pageLabels !== undefined,
                bookmarks: nativeMutationPlan.mutations.bookmarks !== undefined,
                shapes: nativeMutationPlan.mutations.shapes?.shapes.length ?? 0,
                markupOverrides: nativeMutationPlan.mutations.markup?.overrides.length ?? 0,
                markupHints: nativeMutationPlan.mutations.markup?.hints.length ?? 0,
                preserveLoadedSource: true,
            }),
        );
    }

    async function prepareNativeShapeSaveCompletion(nativeMutationPlan: INativePdfMutationPlan) {
        let canMarkShapeStateSaved = !nativeMutationPlan.hasShapeMutations;
        let preparedShapeStateSnapshot: unknown = null;
        if (!nativeMutationPlan.hasShapeMutations) {
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
        nativeMutationPlan: INativePdfMutationPlan,
        persisted: IPdfPersistResult,
        canMarkShapeStateSaved: boolean,
    ) {
        const hasNativeAnnotationMutations = nativeMutationPlan.noteTextUpdates.length > 0
            || nativeMutationPlan.freeTextNotes.length > 0
            || nativeMutationPlan.annotationDeletes.length > 0
            || nativeMutationPlan.hasMarkupMutations
            || nativeMutationPlan.hasShapeMutations;
        const hasNativeBookmarkMutations = nativeMutationPlan.mutations.bookmarks !== undefined;
        const hasNativePageLabelMutations = nativeMutationPlan.mutations.pageLabels !== undefined;
        completion.armPersistedShapeStateAdoption(nativeMutationPlan.hasShapeMutations && canMarkShapeStateSaved);
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
            if (nativeMutationPlan.freeTextNotes.length) {
                persistence.nativeMutations?.markNativeFreeTextNotesSaved?.(nativeMutationPlan.freeTextNotes);
            }
            if (nativeMutationPlan.annotationDeletes.length) {
                persistence.nativeMutations?.markNativeFreeTextNotesDeleted?.(nativeMutationPlan.annotationDeletes);
            }
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
        const nativeMutationPlan = buildNativeMutationPlanForContext(config, context);
        if (!nativeMutationPlan) {
            return {status: 'fall-through' as const};
        }

        let preparedShapeStateSnapshot: unknown = null;
        try {
            const persisted = await persistNativeMutationPlanForContext(config, context, nativeMutationPlan);
            if (!persisted) {
                return {status: 'fall-through' as const};
            }
            const prepared = await prepareNativeShapeSaveCompletion(nativeMutationPlan);
            preparedShapeStateSnapshot = prepared.preparedShapeStateSnapshot;
            const saveSucceeded = await finalizeNativeMutationSave(
                config,
                context,
                nativeMutationPlan,
                persisted,
                prepared.canMarkShapeStateSaved,
            );
            if (saveSucceeded) {
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
        const rawData = await services.source.getSerializationBasePdfBytes({
            forcePdfjsMaterialize: context.savePlan.pdfjsSourceMaterialization.required,
            pendingDeletes: context.pendingDeletes,
            pendingTexts: context.pendingTexts,
        });
        const persistenceExpectedWorkingPath = resolveExpectedWorkingPathForPersistence(
            context.savePlan.staleTargetProtection.expectedWorkingPath,
            context.savePlan.staleTargetProtection.expectedOriginalPath,
        );
        let saveSucceeded = false;
        if (persistenceExpectedWorkingPath) {
            saveSucceeded = await runSerializedSaveFlow(
                rawData,
                context.pendingTexts,
                context.pendingDeletes,
                context.annotationCommentsSnapshot,
                context.shapeStateDirty,
                context.reloadWaiter.current,
                config.mode,
                config.saveMode,
                config.persistSerialized,
                context.savePlan.livePdfjsAnnotationSession.canPreserve,
                context.savePlan.pdfjsSourceMaterialization.includeManagedShapesForLiveSource,
                config.forceRewrite === true,
                persistenceExpectedWorkingPath,
                context.saveStateSnapshot,
                () => services.clearSaveIndicator(config.mode),
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
