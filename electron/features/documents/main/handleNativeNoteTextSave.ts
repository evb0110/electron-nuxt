import {
    mkdtemp,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { join } from 'path';
import type {
    IPdfNativeAnnotationDelete,
    IPdfNativeFreeTextNote,
    IPdfNativeFreeTextNoteMarkerRect,
    IPdfNativeNoteChanges,
    IPdfNativeNoteTextSaveResult,
    IPdfNoteTextUpdate,
} from '@contracts/electronApiDocuments';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
import { isErrnoException } from '@contracts/runtimeGuards';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import {
    isNativePageOpsDisabled,
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/public';
import {
    findWorkingCopyPathByOriginalPath,
    getWorkingCopyOriginalPath,
} from '@electron/file-access/workingCopyStore';
import { isAllowedOriginalSavePath } from '@electron/file-access/isAllowedOriginalSavePath';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { enqueueWorkingCopyMutation } from '@electron/file-access/workingCopyMutationQueue';
import { copyFileCopyOnWrite } from '@electron/file-access/workingCopyDirectory';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

const NATIVE_NOTE_TEXT_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_NATIVE_NOTE_TEXT_UPDATES = 256;
const MAX_NATIVE_NOTE_CHANGES = 256;
const log = createLogger('native-note-text-save');

interface INativeNoteCommandOptions {
    command: 'update-note-text' | 'save-note-changes';
    payloadFileName: string;
    payloadFlag: '--updates-file' | '--changes-file';
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

function normalizeWorkingPath(workingPath: unknown) {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedWorkingPath) {
        throw new Error('Invalid file path');
    }

    return normalizedWorkingPath;
}

function normalizeModifiedAt(modifiedAt: unknown) {
    const normalized = typeof modifiedAt === 'string' ? modifiedAt.trim() : '';
    if (!/^D:\d{14}(?:Z|[+-]\d{2}'\d{2}')?$/u.test(normalized)) {
        throw new Error('Invalid PDF modification timestamp');
    }
    return normalized;
}

function normalizeNoteTextUpdates(updates: unknown) {
    if (!Array.isArray(updates) || updates.length === 0 || updates.length > MAX_NATIVE_NOTE_TEXT_UPDATES) {
        throw new Error('Invalid note text update list');
    }

    return normalizeNoteTextUpdateArray(updates);
}

function normalizeOptionalNoteTextUpdates(updates: unknown) {
    if (updates === undefined) {
        return [];
    }
    if (!Array.isArray(updates) || updates.length > MAX_NATIVE_NOTE_TEXT_UPDATES) {
        throw new Error('Invalid note text update list');
    }

    return normalizeNoteTextUpdateArray(updates);
}

function normalizeNoteTextUpdateArray(updates: unknown[]) {
    return updates.map((update, index): IPdfNoteTextUpdate => {
        if (!update || typeof update !== 'object') {
            throw new Error(`Invalid note text update at index ${index}`);
        }
        const candidate = update as Partial<IPdfNoteTextUpdate>;
        const {
            objectNumber,
            generationNumber,
            text,
        } = candidate;
        if (
            typeof objectNumber !== 'number'
            || !Number.isSafeInteger(objectNumber)
            || objectNumber < 1
            || typeof generationNumber !== 'number'
            || !Number.isSafeInteger(generationNumber)
            || generationNumber < 0
            || generationNumber > 65_535
            || typeof text !== 'string'
        ) {
            throw new Error(`Invalid note text update at index ${index}`);
        }
        return {
            objectNumber,
            generationNumber,
            text,
        };
    });
}

function normalizeFreeTextNoteMarkerRect(value: unknown, label: string): IPdfNativeFreeTextNoteMarkerRect {
    if (!value || typeof value !== 'object') {
        throw new Error(`${label} must be an object`);
    }
    const rect = value as Partial<IPdfNativeFreeTextNoteMarkerRect>;
    const {
        left,
        top,
        width,
        height,
    } = rect;
    if (
        typeof left !== 'number'
        || !Number.isFinite(left)
        || left < 0
        || left > 1
        || typeof top !== 'number'
        || !Number.isFinite(top)
        || top < 0
        || top > 1
        || typeof width !== 'number'
        || !Number.isFinite(width)
        || width <= 0
        || width > 1
        || typeof height !== 'number'
        || !Number.isFinite(height)
        || height <= 0
        || height > 1
        || left + width > 1
        || top + height > 1
    ) {
        throw new Error(`${label} must fit inside normalized page bounds`);
    }
    return {
        left,
        top,
        width,
        height,
    };
}

function normalizeOptionalString(value: unknown) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'string') {
        throw new Error('Expected string or null');
    }
    return value;
}

function normalizeOptionalTimestamp(value: unknown) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error('Expected finite timestamp or null');
    }
    return Math.trunc(value);
}

function normalizeFreeTextNotes(notes: unknown) {
    if (notes === undefined) {
        return [];
    }
    if (!Array.isArray(notes) || notes.length > MAX_NATIVE_NOTE_CHANGES) {
        throw new Error('Invalid FreeText note list');
    }

    return notes.map((note, index): IPdfNativeFreeTextNote => {
        if (!note || typeof note !== 'object') {
            throw new Error(`Invalid FreeText note at index ${index}`);
        }
        const candidate = note as Partial<IPdfNativeFreeTextNote>;
        const stableKey = typeof candidate.stableKey === 'string' ? candidate.stableKey.trim() : '';
        if (
            typeof candidate.pageIndex !== 'number'
            || !Number.isSafeInteger(candidate.pageIndex)
            || candidate.pageIndex < 0
            || !stableKey
            || typeof candidate.text !== 'string'
        ) {
            throw new Error(`Invalid FreeText note at index ${index}`);
        }
        return {
            pageIndex: candidate.pageIndex,
            stableKey,
            text: candidate.text,
            markerRect: normalizeFreeTextNoteMarkerRect(candidate.markerRect, `FreeText note ${index} markerRect`),
            author: normalizeOptionalString(candidate.author),
            color: normalizeOptionalString(candidate.color),
            createdAt: normalizeOptionalTimestamp(candidate.createdAt),
        };
    });
}

function normalizeAnnotationDeletes(deletes: unknown) {
    if (deletes === undefined) {
        return [];
    }
    if (!Array.isArray(deletes) || deletes.length > MAX_NATIVE_NOTE_CHANGES) {
        throw new Error('Invalid native annotation delete list');
    }

    return deletes.map((item, index): IPdfNativeAnnotationDelete => {
        if (!item || typeof item !== 'object') {
            throw new Error(`Invalid native annotation delete at index ${index}`);
        }
        const candidate = item as Partial<IPdfNativeAnnotationDelete>;
        const stableKey = typeof candidate.stableKey === 'string' ? candidate.stableKey.trim() : '';
        const hasRef = candidate.objectNumber !== undefined || candidate.generationNumber !== undefined;
        const hasValidRef = typeof candidate.objectNumber === 'number'
            && Number.isSafeInteger(candidate.objectNumber)
            && candidate.objectNumber >= 1
            && typeof candidate.generationNumber === 'number'
            && Number.isSafeInteger(candidate.generationNumber)
            && candidate.generationNumber >= 0
            && candidate.generationNumber <= 65_535;
        const createdAt = candidate.createdAt === undefined || candidate.createdAt === null
            ? null
            : candidate.createdAt;
        if (
            typeof candidate.pageIndex !== 'number'
            || !Number.isSafeInteger(candidate.pageIndex)
            || candidate.pageIndex < 0
            || (hasRef && !hasValidRef)
            || (!hasValidRef && !stableKey)
            || (createdAt !== null && (
                typeof createdAt !== 'number'
                || !Number.isFinite(createdAt)
                || createdAt < 0
            ))
        ) {
            throw new Error(`Invalid native annotation delete at index ${index}`);
        }
        return {
            pageIndex: candidate.pageIndex,
            ...(hasValidRef
                ? {
                    objectNumber: candidate.objectNumber,
                    generationNumber: candidate.generationNumber,
                }
                : {}),
            ...(stableKey ? {stableKey} : {}),
            ...(createdAt !== null ? {createdAt: Math.trunc(createdAt)} : {}),
        };
    });
}

function normalizeNoteChanges(rawChanges: unknown): IPdfNativeNoteChanges {
    if (!rawChanges || typeof rawChanges !== 'object') {
        throw new Error('Invalid native note changes');
    }
    const candidate = rawChanges as Partial<IPdfNativeNoteChanges>;
    const updates = normalizeOptionalNoteTextUpdates(candidate.updates);
    const freeTextNotes = normalizeFreeTextNotes(candidate.freeTextNotes);
    const deletes = normalizeAnnotationDeletes(candidate.deletes);
    if (updates.length + freeTextNotes.length + deletes.length === 0) {
        throw new Error('At least one native note change is required');
    }
    if (updates.length + freeTextNotes.length + deletes.length > MAX_NATIVE_NOTE_CHANGES) {
        throw new Error('Too many native note changes');
    }
    return {
        ...(updates.length > 0 ? {updates} : {}),
        ...(freeTextNotes.length > 0 ? {freeTextNotes} : {}),
        ...(deletes.length > 0 ? {deletes} : {}),
    };
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

async function syncNativeOutputToLatestWorkingCopy(
    originalPath: string,
    requestedWorkingPath: string,
    senderWebContentsId: number,
) {
    const latestWorkingPath = findWorkingCopyPathByOriginalPath(originalPath, senderWebContentsId)
        ?? requestedWorkingPath;
    const syncLatestWorkingCopy = async () => {
        await ensureWorkingCopyDirectory(latestWorkingPath, senderWebContentsId);
        await copyFileCopyOnWrite(originalPath, latestWorkingPath);
    };

    if (latestWorkingPath === requestedWorkingPath) {
        await syncLatestWorkingCopy();
        return;
    }

    await enqueueWorkingCopyMutation(latestWorkingPath, syncLatestWorkingCopy);
}

async function runNativeNoteCommand(
    event: Electron.IpcMainInvokeEvent,
    workingPath: unknown,
    rawModifiedAt: unknown,
    options: INativeNoteCommandOptions,
): Promise<IPdfNativeNoteTextSaveResult> {
    const normalizedWorkingPath = normalizeWorkingPath(workingPath);
    const modifiedAt = normalizeModifiedAt(rawModifiedAt);

    if (isNativePageOpsDisabled()) {
        return createNotAppliedResult();
    }

    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        return createNotAppliedResult();
    }

    const originalPath = getValidatedOriginalPath(normalizedWorkingPath, event.sender.id);
    if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, event.sender.id)) {
        throw new Error('Working copy path is not managed');
    }

    return enqueueWorkingCopyMutation(normalizedWorkingPath, async () => {
        const phaseTimings: INativeNotePhaseTiming[] = [];
        const operationStart = performance.now();
        if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, event.sender.id)) {
            throw new Error('Working copy path is not managed');
        }

        const tempPath = makeSiblingTempPath(originalPath);
        const tempDir = await mkdtemp(join(tmpdir(), 'pdf-note-text-'));
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
                    timeoutMs: NATIVE_NOTE_TEXT_TIMEOUT_MS,
                    commandLabel: options.commandLabel,
                }));
            await measureNativeNotePhase(phaseTimings, 'assert-output', () =>
                assertNativeOutputReady(tempPath));
            const validation = createNativeValidationResult();

            await measureNativeNotePhase(phaseTimings, 'atomic-replace-original', () =>
                atomicReplace(tempPath, originalPath));
            await measureNativeNotePhase(phaseTimings, 'sync-latest-working-copy', () =>
                syncNativeOutputToLatestWorkingCopy(originalPath, normalizedWorkingPath, event.sender.id));
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
    event: Electron.IpcMainInvokeEvent,
    workingPath: unknown,
    rawUpdates: unknown,
    rawModifiedAt: unknown,
): Promise<IPdfNativeNoteTextSaveResult> {
    const updates = normalizeNoteTextUpdates(rawUpdates);
    return runNativeNoteCommand(event, workingPath, rawModifiedAt, {
        command: 'update-note-text',
        payloadFileName: 'updates.json',
        payloadFlag: '--updates-file',
        payload: {updates},
        commandLabel: 'evb-pdf-page-ops(update-note-text)',
    });
}

export async function handleNativeNoteChangesSave(
    event: Electron.IpcMainInvokeEvent,
    workingPath: unknown,
    rawChanges: unknown,
    rawModifiedAt: unknown,
): Promise<IPdfNativeNoteTextSaveResult> {
    const changes = normalizeNoteChanges(rawChanges);
    return runNativeNoteCommand(event, workingPath, rawModifiedAt, {
        command: 'save-note-changes',
        payloadFileName: 'changes.json',
        payloadFlag: '--changes-file',
        payload: changes,
        commandLabel: 'evb-pdf-page-ops(save-note-changes)',
    });
}
