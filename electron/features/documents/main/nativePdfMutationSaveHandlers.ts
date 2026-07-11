import { createHash } from 'crypto';
import {
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { join } from 'path';
import type {
    IDocumentMutationRevisionOptions,
    IPdfNativeMutationSet,
    IPdfNativeStagedCommitOptions,
    IPdfNativeNoteTextSaveResult,
    IPdfNativeWorkingCopyExpectation,
} from '@contracts/electronApiDocuments';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
import {
    normalizePdfNativeModifiedAt,
    normalizePdfNativeMutationSet,
    normalizePdfNativeNoteChanges,
    normalizePdfNativeNoteTextUpdates,
    normalizePdfNativeWorkingCopyExpectation,
    type TPdfNativeMutationSetNativeToolPayload,
} from '@pdf-core';
import { isErrnoException } from '@contracts/runtimeGuards';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import {
    isNativePageOpsDisabled,
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/public';
import {
    findWorkingCopyPathByOriginalPath,
    getWorkingCopyOriginalPath,
    refreshWorkingCopyOriginalFileExpectation,
} from '@electron/file-access/workingCopyStore';
import { isAllowedOriginalSavePath } from '@electron/file-access/isAllowedOriginalSavePath';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { enqueueWorkingCopyMutation } from '@electron/file-access/workingCopyMutationQueue';
import {
    assertQueuedWorkingCopyMutationPreconditions,
    normalizeExpectedDocumentRevisionToken,
} from '@electron/file-access/documentMutationGuards';
import { copyFileCopyOnWrite } from '@electron/file-access/workingCopyDirectory';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { originalPathSaveBaseMatches } from '@electron/features/documents/main/originalPathSaveBaseMatches';
import {transitionOriginalAndWorkingCopyRevision} from '@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision';
import {commitPdfTempFile} from '@electron/features/documents/main/commitPdfTempFile';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsService';
import {
    createManagedTempFileHandle,
    releaseManagedTempFileHandle,
    resolveManagedTempFileHandle,
} from '@electron/features/documents/main/managedTempFileHandles';

const PDF_NATIVE_MUTATION_TIMEOUT_MS = 2 * 60 * 1000;
const TAIL_ONLY_INCREMENTAL_VALIDATION_ENV = {EVB_PDF_PAGE_OPS_FULL_INCREMENTAL_VALIDATE: '0'} satisfies NodeJS.ProcessEnv;
const log = createLogger('native-note-text-save');

interface INativeNoteCommandOptions {
    command: 'update-note-text' | 'save-note-changes' | 'save-mutations';
    payloadFileName: string;
    payloadFlag: '--updates-file' | '--changes-file' | '--mutations-file';
    payload: unknown;
    commandLabel: string;
    tailOnlyIncrementalValidation?: boolean;
}

interface INativeNotePhaseTiming {
    phase: string;
    durationMs: number;
}

async function materializeNativeBinarySidecars(
    context: IDocumentsSenderIdContext,
    payload: IPdfNativeMutationSet | unknown,
): Promise<TPdfNativeMutationSetNativeToolPayload | unknown> {
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as IPdfNativeMutationSet).placedImages)) {
        return payload;
    }
    const mutationPayload = payload as IPdfNativeMutationSet & {placedImages: NonNullable<IPdfNativeMutationSet['placedImages']>};
    const placedImages = await Promise.all(mutationPayload.placedImages.map(async (image) => {
        const source = await resolveManagedTempFileHandle(context, image.source);
        const {
            source: _source,
            ...metadata
        } = image;
        return {
            ...metadata,
            bytesPath: source.path,
            byteLength: source.size,
            sha256: source.sha256,
        };
    }));
    return {
        ...payload,
        placedImages,
    };
}

function createNotAppliedResult(): IPdfNativeNoteTextSaveResult {
    return {
        applied: false,
        validation: null,
    };
}

function createNativeValidationResult(): IPdfValidationResult {
    return {
        isValid: true,
        tool: 'native',
        errors: [],
        warnings: [],
    };
}

function requireSenderId(context: IDocumentsSenderIdContext): number {
    if (typeof context.senderId !== 'number') {
        throw new Error('Missing sender identity');
    }
    return context.senderId;
}

function normalizeWorkingPath(workingPath: unknown): string {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedWorkingPath) {
        throw new Error('Invalid file path');
    }

    return normalizedWorkingPath;
}

function normalizeModifiedAt(modifiedAt: unknown): ReturnType<typeof normalizePdfNativeModifiedAt> {
    try {
        return normalizePdfNativeModifiedAt(modifiedAt, 'modifiedAt', {errorKind: 'error'});
    } catch {
        throw new Error('Invalid PDF modification timestamp');
    }
}

function normalizeWorkingCopyExpectation(rawExpectedBase: unknown): IPdfNativeWorkingCopyExpectation {
    try {
        return normalizePdfNativeWorkingCopyExpectation(rawExpectedBase, 'native working-copy expectation', {errorKind: 'error'});
    } catch {
        throw new Error('Invalid native working-copy expectation');
    }
}

function normalizeNativeMutationSet(rawMutations: unknown): IPdfNativeMutationSet {
    return normalizePdfNativeMutationSet(rawMutations, 'native PDF mutations', {errorKind: 'error'});
}

function shouldUseTailOnlyIncrementalValidation(mutations: IPdfNativeMutationSet): boolean {
    const hasMetadataMutation = Boolean(mutations.pageLabels) || Boolean(mutations.bookmarks);
    return hasMetadataMutation
        && !mutations.updates?.length
        && !mutations.freeTextNotes?.length
        && !mutations.deletes?.length
        && !mutations.shapes
        && !mutations.markup
        && !mutations.placedImages?.length;
}

async function workingCopyMatchesExpectation(
    workingPath: string,
    expectedBase: IPdfNativeWorkingCopyExpectation,
) {
    const bytes = await readFile(workingPath);
    if (bytes.byteLength !== expectedBase.byteLength) {
        return false;
    }
    const sha256 = createHash('sha256')
        .update(bytes)
        .digest('hex');
    return sha256 === expectedBase.sha256;
}

function getValidatedOriginalPath(workingPath: string, senderWebContentsId: number): string {
    const originalPath = getWorkingCopyOriginalPath(workingPath, senderWebContentsId)?.originalPath;
    if (!originalPath) {
        throw new Error('No original path found for this working copy');
    }
    if (!isAllowedOriginalSavePath(originalPath)) {
        throw new Error('Invalid original path for this working copy');
    }

    return originalPath;
}

async function assertNativeOutputReady(outputPath: string): Promise<void> {
    const outputStat = await stat(outputPath);
    if (outputStat.size === 0) {
        throw new Error('Native note text update produced an empty PDF');
    }
}

async function cleanupTempPath(path: string): Promise<void> {
    await rm(path, {force: true}).catch((error: unknown) => {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return;
        }
        log.debug(`Failed to cleanup native note text temp file "${path}": ${getErrorMessage(error)}`);
    });
}

async function measureNativeNotePhase<T>(
    phaseTimings: INativeNotePhaseTiming[],
    phase: string,
    operation: () => Promise<T>,
) {
    const start = performance.now();
    try {
        return await operation();
    } finally {
        phaseTimings.push({
            phase,
            durationMs: Math.round((performance.now() - start) * 10) / 10,
        });
    }
}

async function syncNativeOutputToRequestingWorkingCopy(
    originalPath: string,
    requestedWorkingPath: string,
    senderWebContentsId: number,
): Promise<void> {
    const currentWorkingPath = findWorkingCopyPathByOriginalPath(originalPath, senderWebContentsId);
    await ensureWorkingCopyDirectory(requestedWorkingPath, senderWebContentsId);
    await copyFileCopyOnWrite(originalPath, requestedWorkingPath);
    if (!await refreshWorkingCopyOriginalFileExpectation(requestedWorkingPath, senderWebContentsId)) {
        throw new Error('Working copy registration changed before original expectation refresh completed');
    }

    if (currentWorkingPath && currentWorkingPath !== requestedWorkingPath) {
        log.debug(`Skipped native output sync to distinct current working copy: ${JSON.stringify({
            currentWorkingPath,
            requestedWorkingPath,
        })}`);
    }
}

async function runNativeNoteCommand(
    context: IDocumentsSenderIdContext,
    workingPath: unknown,
    rawModifiedAt: unknown,
    revisionOptions: IDocumentMutationRevisionOptions | undefined,
    options: INativeNoteCommandOptions,
): Promise<IPdfNativeNoteTextSaveResult> {
    const senderId = requireSenderId(context);
    const normalizedWorkingPath = normalizeWorkingPath(workingPath);
    const modifiedAt = normalizeModifiedAt(rawModifiedAt);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(revisionOptions);

    if (isNativePageOpsDisabled()) {
        return createNotAppliedResult();
    }

    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        return createNotAppliedResult();
    }

    const originalPath = getValidatedOriginalPath(normalizedWorkingPath, senderId);
    if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, senderId)) {
        throw new Error('Working copy path is not managed');
    }

    return enqueueWorkingCopyMutation(normalizedWorkingPath, async (mutationOperation) => {
        const phaseTimings: INativeNotePhaseTiming[] = [];
        const operationStart = performance.now();
        await assertQueuedWorkingCopyMutationPreconditions(
            normalizedWorkingPath,
            expectedDocumentRevisionToken,
        );
        if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, senderId)) {
            throw new Error('Working copy path is not managed');
        }

        const tempPath = makeSiblingTempPath(originalPath);
        const tempDir = await mkdtemp(join(tmpdir(), 'pdf-note-text-'));
        const payloadFilePath = join(tempDir, options.payloadFileName);
        let committedValidation: IPdfNativeNoteTextSaveResult['validation'] = null;
        let committed = false;
        try {
            await measureNativeNotePhase(phaseTimings, 'write-payload', async () => {
                const nativePayload = await materializeNativeBinarySidecars(context, options.payload);
                await writeFile(payloadFilePath, JSON.stringify(nativePayload));
            });
            await measureNativeNotePhase(phaseTimings, 'clone-working-to-temp', () =>
                copyFileCopyOnWrite(normalizedWorkingPath, tempPath));
            await measureNativeNotePhase(phaseTimings, 'native-command', () =>
                runNativeToolCommand(binaryPath, [
                    options.command,
                    '--input',
                    tempPath,
                    '--output',
                    tempPath,
                    options.payloadFlag,
                    payloadFilePath,
                    '--modified-at',
                    modifiedAt,
                    '--append',
                ], {
                    timeoutMs: PDF_NATIVE_MUTATION_TIMEOUT_MS,
                    commandLabel: options.commandLabel,
                    ...(options.tailOnlyIncrementalValidation ? {env: TAIL_ONLY_INCREMENTAL_VALIDATION_ENV} : {}),
                    signal: mutationOperation.signal,
                    cancelGroup: mutationOperation.cancelGroup,
                }));
            await measureNativeNotePhase(phaseTimings, 'assert-output', () =>
                assertNativeOutputReady(tempPath));
            const validation = createNativeValidationResult();
            const transition = await transitionOriginalAndWorkingCopyRevision({
                workingCopyPath: normalizedWorkingPath,
                originalPath,
                reason: 'native-mutation',
                senderId,
                assertOriginalCurrent: () => measureNativeNotePhase(phaseTimings, 'assert-original-base', () =>
                    originalPathSaveBaseMatches(normalizedWorkingPath, originalPath, senderId)),
                publishOriginal: () => measureNativeNotePhase(phaseTimings, 'atomic-replace-original', () =>
                    atomicReplace(tempPath, originalPath)),
                afterWorkingCopySync: () => syncNativeOutputToRequestingWorkingCopy(
                    originalPath,
                    normalizedWorkingPath,
                    senderId,
                ),
            });
            const originalCommitted = transition !== null;
            if (!originalCommitted) {
                return createNotAppliedResult();
            }
            committed = true;
            committedValidation = validation;
            log.debug(`Native note save phase timings: ${JSON.stringify({
                command: options.command,
                totalMs: Math.round((performance.now() - operationStart) * 10) / 10,
                phases: phaseTimings,
            })}`);
            return {
                applied: true,
                validation,
            };
        } catch (error) {
            log.debug(`Native note text update failed, falling back to pdf-lib: ${JSON.stringify({
                command: options.command,
                totalMs: Math.round((performance.now() - operationStart) * 10) / 10,
                phases: phaseTimings,
                error: getErrorMessage(error),
            })}`);
            if (committed) {
                return {
                    applied: true,
                    validation: committedValidation,
                    syncError: getErrorMessage(error),
                };
            }
            return createNotAppliedResult();
        } finally {
            await cleanupTempPath(tempPath);
            await rm(tempDir, {
                recursive: true,
                force: true,
            }).catch(() => undefined);
        }
    });
}

async function runNativeWorkingCopyCommand(
    context: IDocumentsSenderIdContext,
    workingPath: unknown,
    rawModifiedAt: unknown,
    rawExpectedBase: unknown,
    revisionOptions: IDocumentMutationRevisionOptions | undefined,
    options: INativeNoteCommandOptions,
): Promise<IPdfNativeNoteTextSaveResult> {
    const senderId = requireSenderId(context);
    const normalizedWorkingPath = normalizeWorkingPath(workingPath);
    const modifiedAt = normalizeModifiedAt(rawModifiedAt);
    const expectedBase = normalizeWorkingCopyExpectation(rawExpectedBase);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(revisionOptions);

    if (isNativePageOpsDisabled()) {
        return createNotAppliedResult();
    }

    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        return createNotAppliedResult();
    }

    if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, senderId)) {
        throw new Error('Working copy path is not managed');
    }

    return enqueueWorkingCopyMutation(normalizedWorkingPath, async (mutationOperation) => {
        const phaseTimings: INativeNotePhaseTiming[] = [];
        const operationStart = performance.now();
        await assertQueuedWorkingCopyMutationPreconditions(
            normalizedWorkingPath,
            expectedDocumentRevisionToken,
        );
        if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, senderId)) {
            throw new Error('Working copy path is not managed');
        }
        if (!await workingCopyMatchesExpectation(normalizedWorkingPath, expectedBase)) {
            log.debug(`Native working-copy mutation skipped because base expectation no longer matches: ${JSON.stringify({
                command: options.command,
                totalMs: Math.round((performance.now() - operationStart) * 10) / 10,
            })}`);
            return createNotAppliedResult();
        }

        const tempPath = makeSiblingTempPath(normalizedWorkingPath);
        const tempDir = await mkdtemp(join(tmpdir(), 'pdf-working-copy-mutation-'));
        const payloadFilePath = join(tempDir, options.payloadFileName);
        let staged = false;
        try {
            await measureNativeNotePhase(phaseTimings, 'write-payload', async () => {
                const nativePayload = await materializeNativeBinarySidecars(context, options.payload);
                await writeFile(payloadFilePath, JSON.stringify(nativePayload));
            });
            await measureNativeNotePhase(phaseTimings, 'clone-working-to-temp', () =>
                copyFileCopyOnWrite(normalizedWorkingPath, tempPath));
            await measureNativeNotePhase(phaseTimings, 'native-command', () =>
                runNativeToolCommand(binaryPath, [
                    options.command,
                    '--input',
                    tempPath,
                    '--output',
                    tempPath,
                    options.payloadFlag,
                    payloadFilePath,
                    '--modified-at',
                    modifiedAt,
                    '--append',
                ], {
                    timeoutMs: PDF_NATIVE_MUTATION_TIMEOUT_MS,
                    commandLabel: options.commandLabel,
                    ...(options.tailOnlyIncrementalValidation ? {env: TAIL_ONLY_INCREMENTAL_VALIDATION_ENV} : {}),
                    signal: mutationOperation.signal,
                    cancelGroup: mutationOperation.cancelGroup,
                }));
            await measureNativeNotePhase(phaseTimings, 'assert-output', () =>
                assertNativeOutputReady(tempPath));
            const validation = createNativeValidationResult();

            const stagedOutput = await createManagedTempFileHandle(context, tempPath, {cleanupOnRelease: true});
            staged = true;
            log.debug(`Native working-copy mutation phase timings: ${JSON.stringify({
                command: options.command,
                totalMs: Math.round((performance.now() - operationStart) * 10) / 10,
                phases: phaseTimings,
            })}`);
            return {
                applied: true,
                validation,
                stagedOutput,
            };
        } catch (error) {
            log.debug(`Native working-copy mutation failed, falling back to pdf-lib: ${JSON.stringify({
                command: options.command,
                totalMs: Math.round((performance.now() - operationStart) * 10) / 10,
                phases: phaseTimings,
                error: getErrorMessage(error),
            })}`);
            return createNotAppliedResult();
        } finally {
            if (!staged) await cleanupTempPath(tempPath);
            await rm(tempDir, {
                recursive: true,
                force: true,
            }).catch(() => undefined);
        }
    });
}

/** Promotes a verified immutable native artifact to original and WC exactly once. */
export async function handleCommitStagedPdfNativeMutations(
    context: IDocumentsSenderIdContext,
    workingPath: unknown,
    rawStagedOutput: unknown,
    revisionOptions?: IPdfNativeStagedCommitOptions,
): Promise<IPdfNativeNoteTextSaveResult> {
    const senderId = requireSenderId(context);
    const normalizedWorkingPath = normalizeWorkingPath(workingPath);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(revisionOptions);
    const stagedOutput = await resolveManagedTempFileHandle(context, rawStagedOutput);
    const originalPath = getValidatedOriginalPath(normalizedWorkingPath, senderId);
    try {
        return await enqueueWorkingCopyMutation(normalizedWorkingPath, async () => {
            await assertQueuedWorkingCopyMutationPreconditions(
                normalizedWorkingPath,
                expectedDocumentRevisionToken,
            );
            const originalTempPath = makeSiblingTempPath(originalPath);
            try {
                await copyFileCopyOnWrite(stagedOutput.path, originalTempPath);
                const transition = await transitionOriginalAndWorkingCopyRevision({
                    workingCopyPath: normalizedWorkingPath,
                    originalPath,
                    reason: 'native-mutation',
                    senderId,
                    assertOriginalCurrent: () => originalPathSaveBaseMatches(
                        normalizedWorkingPath,
                        originalPath,
                        senderId,
                    ),
                    publishOriginal: async () => {
                        await commitPdfTempFile(originalTempPath, originalPath, revisionOptions?.changedObjectRefs?.length
                            ? {changedObjectRefs: revisionOptions.changedObjectRefs}
                            : {});
                    },
                    afterWorkingCopySync: () => syncNativeOutputToRequestingWorkingCopy(
                        originalPath,
                        normalizedWorkingPath,
                        senderId,
                    ),
                });
                return transition
                    ? {
                        applied: true,
                        validation: createNativeValidationResult(),
                    }
                    : createNotAppliedResult();
            } finally {
                await cleanupTempPath(originalTempPath);
            }
        });
    } finally {
        releaseManagedTempFileHandle(context, stagedOutput.leaseId);
        await cleanupTempPath(stagedOutput.path);
    }
}

export async function handleNativeNoteTextSave(
    context: IDocumentsSenderIdContext,
    workingPath: unknown,
    rawUpdates: unknown,
    rawModifiedAt: unknown,
    revisionOptions?: IDocumentMutationRevisionOptions,
): Promise<IPdfNativeNoteTextSaveResult> {
    const updates = normalizePdfNativeNoteTextUpdates(rawUpdates, 'note text update list', {errorKind: 'error'});
    return runNativeNoteCommand(context, workingPath, rawModifiedAt, revisionOptions, {
        command: 'update-note-text',
        payloadFileName: 'updates.json',
        payloadFlag: '--updates-file',
        payload: {updates},
        commandLabel: 'evb-pdf-page-ops(update-note-text)',
    });
}

export async function handleNativeNoteChangesSave(
    context: IDocumentsSenderIdContext,
    workingPath: unknown,
    rawChanges: unknown,
    rawModifiedAt: unknown,
    revisionOptions?: IDocumentMutationRevisionOptions,
): Promise<IPdfNativeNoteTextSaveResult> {
    const changes = normalizePdfNativeNoteChanges(rawChanges, 'native note changes', {errorKind: 'error'});
    return runNativeNoteCommand(context, workingPath, rawModifiedAt, revisionOptions, {
        command: 'save-note-changes',
        payloadFileName: 'changes.json',
        payloadFlag: '--changes-file',
        payload: changes,
        commandLabel: 'evb-pdf-page-ops(save-note-changes)',
    });
}

export async function handleNativePdfMutationsSave(
    context: IDocumentsSenderIdContext,
    workingPath: unknown,
    rawMutations: unknown,
    rawModifiedAt: unknown,
    revisionOptions?: IDocumentMutationRevisionOptions,
): Promise<IPdfNativeNoteTextSaveResult> {
    const mutations = normalizeNativeMutationSet(rawMutations);
    return runNativeNoteCommand(context, workingPath, rawModifiedAt, revisionOptions, {
        command: 'save-mutations',
        payloadFileName: 'mutations.json',
        payloadFlag: '--mutations-file',
        payload: mutations,
        commandLabel: 'evb-pdf-page-ops(save-mutations)',
        tailOnlyIncrementalValidation: shouldUseTailOnlyIncrementalValidation(mutations),
    });
}

export async function handleNativePdfMutationsApplyToWorkingCopy(
    context: IDocumentsSenderIdContext,
    workingPath: unknown,
    rawMutations: unknown,
    rawModifiedAt: unknown,
    rawExpectedBase: unknown,
    revisionOptions?: IDocumentMutationRevisionOptions,
): Promise<IPdfNativeNoteTextSaveResult> {
    const mutations = normalizeNativeMutationSet(rawMutations);
    return runNativeWorkingCopyCommand(context, workingPath, rawModifiedAt, rawExpectedBase, revisionOptions, {
        command: 'save-mutations',
        payloadFileName: 'mutations.json',
        payloadFlag: '--mutations-file',
        payload: mutations,
        commandLabel: 'evb-pdf-page-ops(save-mutations-working-copy)',
        tailOnlyIncrementalValidation: shouldUseTailOnlyIncrementalValidation(mutations),
    });
}
