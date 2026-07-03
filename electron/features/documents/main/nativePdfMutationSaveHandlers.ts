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
import { markWorkingCopyContentChanged } from '@electron/file-access/documentRevisionStore';
import { copyFileCopyOnWrite } from '@electron/file-access/workingCopyDirectory';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { originalPathSaveBaseMatches } from '@electron/features/documents/main/originalPathSaveBaseMatches';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsService';

const PDF_NATIVE_MUTATION_TIMEOUT_MS = 2 * 60 * 1000;
const log = createLogger('native-note-text-save');

interface INativeNoteCommandOptions {
    command: 'update-note-text' | 'save-note-changes' | 'save-mutations';
    payloadFileName: string;
    payloadFlag: '--updates-file' | '--changes-file' | '--mutations-file';
    payload: unknown;
    commandLabel: string;
}

interface INativeNotePhaseTiming {
    phase: string;
    durationMs: number;
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

function requireSenderId(context: IDocumentsSenderIdContext) {
    if (typeof context.senderId !== 'number') {
        throw new Error('Missing sender identity');
    }
    return context.senderId;
}

function normalizeWorkingPath(workingPath: unknown) {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedWorkingPath) {
        throw new Error('Invalid file path');
    }

    return normalizedWorkingPath;
}

function normalizeModifiedAt(modifiedAt: unknown) {
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

function normalizeNativeMutationSet(rawMutations: unknown): TPdfNativeMutationSetNativeToolPayload {
    return normalizePdfNativeMutationSet(rawMutations, 'native PDF mutations', {
        errorKind: 'error',
        placedImageBytes: 'numberArray',
    });
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

function getValidatedOriginalPath(workingPath: string, senderWebContentsId: number) {
    const originalPath = getWorkingCopyOriginalPath(workingPath, senderWebContentsId)?.originalPath;
    if (!originalPath) {
        throw new Error('No original path found for this working copy');
    }
    if (!isAllowedOriginalSavePath(originalPath)) {
        throw new Error('Invalid original path for this working copy');
    }

    return originalPath;
}

async function assertNativeOutputReady(outputPath: string) {
    const outputStat = await stat(outputPath);
    if (outputStat.size === 0) {
        throw new Error('Native note text update produced an empty PDF');
    }
}

async function cleanupTempPath(path: string) {
    await rm(path, {force: true}).catch((error) => {
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
) {
    const currentWorkingPath = findWorkingCopyPathByOriginalPath(originalPath, senderWebContentsId);
    await ensureWorkingCopyDirectory(requestedWorkingPath, senderWebContentsId);
    await copyFileCopyOnWrite(originalPath, requestedWorkingPath);
    refreshWorkingCopyOriginalFileExpectation(requestedWorkingPath, senderWebContentsId);

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
    options: INativeNoteCommandOptions,
): Promise<IPdfNativeNoteTextSaveResult> {
    const senderId = requireSenderId(context);
    const normalizedWorkingPath = normalizeWorkingPath(workingPath);
    const modifiedAt = normalizeModifiedAt(rawModifiedAt);

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

    return enqueueWorkingCopyMutation(normalizedWorkingPath, async () => {
        const phaseTimings: INativeNotePhaseTiming[] = [];
        const operationStart = performance.now();
        if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, senderId)) {
            throw new Error('Working copy path is not managed');
        }

        const tempPath = makeSiblingTempPath(originalPath);
        const tempDir = await mkdtemp(join(tmpdir(), 'pdf-note-text-'));
        const payloadFilePath = join(tempDir, options.payloadFileName);
        let committedValidation: IPdfNativeNoteTextSaveResult['validation'] = null;
        let committed = false;
        try {
            await measureNativeNotePhase(phaseTimings, 'write-payload', () =>
                writeFile(payloadFilePath, JSON.stringify(options.payload)));
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
                }));
            await measureNativeNotePhase(phaseTimings, 'assert-output', () =>
                assertNativeOutputReady(tempPath));
            const validation = createNativeValidationResult();
            const originalBaseMatches = await measureNativeNotePhase(phaseTimings, 'assert-original-base', () =>
                originalPathSaveBaseMatches(normalizedWorkingPath, originalPath, senderId));
            if (!originalBaseMatches) {
                log.debug(`Native note save skipped because original base expectation no longer matches: ${JSON.stringify({
                    command: options.command,
                    totalMs: Math.round((performance.now() - operationStart) * 10) / 10,
                })}`);
                return createNotAppliedResult();
            }

            await measureNativeNotePhase(phaseTimings, 'atomic-replace-original', () =>
                atomicReplace(tempPath, originalPath));
            committed = true;
            committedValidation = validation;
            try {
                await measureNativeNotePhase(phaseTimings, 'sync-requesting-working-copy', () =>
                    syncNativeOutputToRequestingWorkingCopy(originalPath, normalizedWorkingPath, senderId));
                await markWorkingCopyContentChanged(normalizedWorkingPath, 'native-mutation', senderId);
            } catch (syncError) {
                log.warn(`Native note save committed, but working copy sync failed: ${JSON.stringify({
                    command: options.command,
                    totalMs: Math.round((performance.now() - operationStart) * 10) / 10,
                    phases: phaseTimings,
                    error: getErrorMessage(syncError),
                })}`);
                return {
                    applied: true,
                    validation,
                    syncError: getErrorMessage(syncError),
                };
            }
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
    options: INativeNoteCommandOptions,
): Promise<IPdfNativeNoteTextSaveResult> {
    const senderId = requireSenderId(context);
    const normalizedWorkingPath = normalizeWorkingPath(workingPath);
    const modifiedAt = normalizeModifiedAt(rawModifiedAt);
    const expectedBase = normalizeWorkingCopyExpectation(rawExpectedBase);

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

    return enqueueWorkingCopyMutation(normalizedWorkingPath, async () => {
        const phaseTimings: INativeNotePhaseTiming[] = [];
        const operationStart = performance.now();
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
        try {
            await measureNativeNotePhase(phaseTimings, 'write-payload', () =>
                writeFile(payloadFilePath, JSON.stringify(options.payload)));
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
                }));
            await measureNativeNotePhase(phaseTimings, 'assert-output', () =>
                assertNativeOutputReady(tempPath));
            const validation = createNativeValidationResult();

            await measureNativeNotePhase(phaseTimings, 'atomic-replace-working-copy', () =>
                atomicReplace(tempPath, normalizedWorkingPath));
            await markWorkingCopyContentChanged(normalizedWorkingPath, 'native-mutation', senderId);
            log.debug(`Native working-copy mutation phase timings: ${JSON.stringify({
                command: options.command,
                totalMs: Math.round((performance.now() - operationStart) * 10) / 10,
                phases: phaseTimings,
            })}`);
            return {
                applied: true,
                validation,
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
            await cleanupTempPath(tempPath);
            await rm(tempDir, {
                recursive: true,
                force: true,
            }).catch(() => undefined);
        }
    });
}

export async function handleNativeNoteTextSave(
    context: IDocumentsSenderIdContext,
    workingPath: unknown,
    rawUpdates: unknown,
    rawModifiedAt: unknown,
): Promise<IPdfNativeNoteTextSaveResult> {
    const updates = normalizePdfNativeNoteTextUpdates(rawUpdates, 'note text update list', {errorKind: 'error'});
    return runNativeNoteCommand(context, workingPath, rawModifiedAt, {
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
): Promise<IPdfNativeNoteTextSaveResult> {
    const changes = normalizePdfNativeNoteChanges(rawChanges, 'native note changes', {errorKind: 'error'});
    return runNativeNoteCommand(context, workingPath, rawModifiedAt, {
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
): Promise<IPdfNativeNoteTextSaveResult> {
    const mutations = normalizeNativeMutationSet(rawMutations);
    return runNativeNoteCommand(context, workingPath, rawModifiedAt, {
        command: 'save-mutations',
        payloadFileName: 'mutations.json',
        payloadFlag: '--mutations-file',
        payload: mutations,
        commandLabel: 'evb-pdf-page-ops(save-mutations)',
    });
}

export async function handleNativePdfMutationsApplyToWorkingCopy(
    context: IDocumentsSenderIdContext,
    workingPath: unknown,
    rawMutations: unknown,
    rawModifiedAt: unknown,
    rawExpectedBase: unknown,
): Promise<IPdfNativeNoteTextSaveResult> {
    const mutations = normalizeNativeMutationSet(rawMutations);
    return runNativeWorkingCopyCommand(context, workingPath, rawModifiedAt, rawExpectedBase, {
        command: 'save-mutations',
        payloadFileName: 'mutations.json',
        payloadFlag: '--mutations-file',
        payload: mutations,
        commandLabel: 'evb-pdf-page-ops(save-mutations-working-copy)',
    });
}
