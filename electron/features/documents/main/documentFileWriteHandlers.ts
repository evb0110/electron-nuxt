import {
    basename,
    extname,
    resolve,
} from 'path';
import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {createReadStream} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
    cp,
    readFile,
    rm,
    unlink,
    writeFile,
} from 'node:fs/promises';
import {isErrnoException} from '@contracts/runtimeGuards';
import {
    resolveAllowedReadPath,
    resolveAllowedWritePath,
} from '@electron/utils/pathValidator';
import {
    clearWorkingCopySearchArtifacts,
    enqueueWorkingCopyMutation,
} from '@electron/file-access/workingCopyMutationQueue';
import {ensureWorkingCopyMaterialized} from '@electron/file-access/workingCopyMaterialization';
import type { IDocumentMutationRevisionOptions } from '@contracts/electronApiDocuments';
import {transitionWorkingCopyContentRevision} from '@electron/file-access/documentRevisionStore';
import {
    assertQueuedWorkingCopyMutationPreconditions,
    normalizeExpectedDocumentRevisionToken,
} from '@electron/file-access/documentMutationGuards';
import { consumeAllowedDocxWritePath } from '@electron/file-access/docxExportPaths';
import {
    copyFileAtomic,
    normalizeIpcWritePayload,
    writeFileAtomic,
} from '@electron/file-access/documentFileWriteAtomic';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import {validatePdfFile} from '@electron/features/documents/main/pdfConformance';
import { normalizeNonEmptyPath } from '@electron/features/documents/main/documentFilePathResolution';
import {
    getWorkingCopyOriginalPath,
    refreshWorkingCopyOriginalFileExpectation,
} from '@electron/file-access/workingCopyStore';
import { originalPathSaveBaseMatches } from '@electron/features/documents/main/originalPathSaveBaseMatches';
import { findPendingOcrResultFileForPath } from '@electron/ocr/createPendingResultFileStore';
import { rebindDocumentTextCatalogRevision } from '@electron/ocr/documentTextCatalog';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsService';

function requireSenderId(context: IDocumentsSenderIdContext) {
    if (typeof context.senderId !== 'number') {
        throw new Error('Missing sender identity');
    }
    return context.senderId;
}

async function sha256File(path: string) {
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), hash);
    return hash.digest('hex');
}

function assertOcrPdfResultSourcePath(resolvedPath: string, senderWebContentsId: number) {
    const fileName = basename(resolvedPath).toLowerCase();
    if (extname(fileName) !== '.pdf') {
        throw new Error('Invalid source path: OCR result must be a PDF');
    }
    if (!fileName.startsWith('ocr-') && !fileName.startsWith('searchable-')) {
        throw new Error('Invalid source path: only OCR result files can replace a working copy');
    }
    const pendingResult = findPendingOcrResultFileForPath(senderWebContentsId, resolvedPath);
    if (!pendingResult) {
        throw new Error('Invalid source path: OCR result is not owned by this renderer');
    }
    return pendingResult;
}

async function shouldRefreshOriginalSaveBaseAfterWorkingCopyReplacement(
    workingCopyPath: string,
    senderWebContentsId: number,
) {
    const mapping = getWorkingCopyOriginalPath(workingCopyPath, senderWebContentsId);
    if (!mapping) {
        return false;
    }

    return originalPathSaveBaseMatches(workingCopyPath, mapping.originalPath, senderWebContentsId);
}

export async function handleFileWrite(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    data: unknown,
    options?: IDocumentMutationRevisionOptions,
) {
    const senderId = requireSenderId(context);
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const payload = normalizeIpcWritePayload(data);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const resolvedPath = await resolveAllowedWritePath(normalizedPath);
    if (!resolvedPath) {
        throw new Error('Invalid file path: writes only allowed within temp directory');
    }

    return enqueueWorkingCopyMutation(resolvedPath, async () => {
        await assertQueuedWorkingCopyMutationPreconditions(resolvedPath, expectedDocumentRevisionToken);
        await ensureWorkingCopyMaterialized(resolvedPath, {
            ownerWebContentsId: senderId,
            reason: 'first-mutation',
        });
        const tempPath = makeSiblingTempPath(resolvedPath);
        let committed = false;
        try {
            await writeFileAtomic(tempPath, payload);
            const validation = await validatePdfFile(tempPath);
            if (!validation.isValid) {
                throw new Error(`PDF write verification failed: ${validation.errors.join('; ')}`);
            }
            await transitionWorkingCopyContentRevision(
                resolvedPath,
                'write',
                async () => {
                    await atomicReplace(tempPath, resolvedPath);
                    committed = true;
                },
                senderId,
            );
        } finally {
            if (!committed) await unlink(tempPath).catch(() => undefined);
        }
        return true;
    });
}

export async function handleReplaceWorkingCopyFromPath(
    context: IDocumentsSenderIdContext,
    workingCopyPath: unknown,
    sourcePath: unknown,
    options?: IDocumentMutationRevisionOptions,
) {
    const senderId = requireSenderId(context);
    const normalizedWorkingCopyPath = normalizeNonEmptyPath(workingCopyPath);
    const normalizedSourcePath = normalizeNonEmptyPath(sourcePath);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const resolvedWorkingCopyPath = await resolveAllowedWritePath(normalizedWorkingCopyPath);
    if (!resolvedWorkingCopyPath) {
        throw new Error('Invalid file path: writes only allowed within temp directory');
    }
    const resolvedSourcePath = await resolveAllowedReadPath(normalizedSourcePath);
    if (!resolvedSourcePath) {
        throw new Error('Invalid source path: OCR result must be within temp directory');
    }
    const pendingResult = assertOcrPdfResultSourcePath(resolvedSourcePath, senderId);

    return enqueueWorkingCopyMutation(resolvedWorkingCopyPath, async () => {
        const journalPath = `${resolvedWorkingCopyPath}.ocr-transition.json`;
        const priorTransition = await readFile(journalPath, 'utf8')
            .then(raw => JSON.parse(raw) as {
                transitionId?: unknown;
                state?: unknown
            })
            .catch(() => null);
        if (priorTransition?.transitionId === pendingResult.requestId && priorTransition.state === 'committed') {
            return true;
        }
        await assertQueuedWorkingCopyMutationPreconditions(
            resolvedWorkingCopyPath,
            expectedDocumentRevisionToken,
        );
        await ensureWorkingCopyMaterialized(resolvedWorkingCopyPath, {
            ownerWebContentsId: senderId,
            reason: 'ocr-persist',
        });
        if (!expectedDocumentRevisionToken) {
            throw new Error('OCR apply requires the source document revision');
        }
        if (await sha256File(resolvedSourcePath) !== pendingResult.resultSha256) {
            throw new Error('OCR result content hash does not match the verified worker result');
        }
        const shouldRefreshOriginalSaveBase = await shouldRefreshOriginalSaveBaseAfterWorkingCopyReplacement(
            resolvedWorkingCopyPath,
            senderId,
        );
        const transitionId = pendingResult.requestId;
        const transitionSuffix = `${process.pid}-${randomUUID()}`;
        const pdfBackupPath = `${resolvedWorkingCopyPath}.ocr-transition-${transitionSuffix}.bak`;
        const catalogPath = `${resolvedWorkingCopyPath}.ocr`;
        const stagedCatalogPath = `${resolvedSourcePath}.ocr`;
        const catalogBackupPath = `${catalogPath}.transition-${transitionSuffix}.bak`;

        await copyFileAtomic(resolvedWorkingCopyPath, pdfBackupPath);
        let catalogBackupExisted = true;
        try {
            await cp(catalogPath, catalogBackupPath, {recursive: true});
        } catch (error) {
            if (!isErrnoException(error) || error.code !== 'ENOENT') {
                await unlink(pdfBackupPath).catch(() => undefined);
                throw error;
            }
            catalogBackupExisted = false;
        }
        await writeFile(journalPath, JSON.stringify({
            version: 1,
            transitionId,
            state: 'prepared',
            workingCopyPath: resolvedWorkingCopyPath,
            resultPath: resolvedSourcePath,
            expectedDocumentRevisionToken,
            pdfBackupPath,
            catalogBackupPath,
            catalogBackupExisted,
            createdAt: Date.now(),
        }), 'utf8');
        let transitionPublished = false;
        try {
            const transitionEvent = await transitionWorkingCopyContentRevision(
                resolvedWorkingCopyPath,
                'ocr-apply',
                async nextRevision => {
                    try {
                        await writeFile(journalPath, JSON.stringify({
                            version: 1,
                            transitionId,
                            state: 'prepared',
                            workingCopyPath: resolvedWorkingCopyPath,
                            resultPath: resolvedSourcePath,
                            expectedDocumentRevisionToken,
                            targetDocumentRevisionToken: nextRevision.token,
                            pdfBackupPath,
                            catalogBackupPath,
                            catalogBackupExisted,
                            createdAt: Date.now(),
                        }), 'utf8');
                        await copyFileAtomic(resolvedSourcePath, resolvedWorkingCopyPath);
                        await rm(catalogPath, {
                            recursive: true,
                            force: true,
                        });
                        await cp(stagedCatalogPath, catalogPath, {recursive: true});
                        await rebindDocumentTextCatalogRevision(
                            resolvedWorkingCopyPath,
                            expectedDocumentRevisionToken,
                            nextRevision.token,
                        );
                        await clearWorkingCopySearchArtifacts(resolvedWorkingCopyPath);
                    } catch (error) {
                        await copyFileAtomic(pdfBackupPath, resolvedWorkingCopyPath).catch(() => undefined);
                        await rm(catalogPath, {
                            recursive: true,
                            force: true,
                        }).catch(() => undefined);
                        if (catalogBackupExisted) {
                            await cp(catalogBackupPath, catalogPath, {recursive: true}).catch(() => undefined);
                        }
                        throw error;
                    }
                },
                senderId,
            );
            transitionPublished = true;
            await writeFile(journalPath, JSON.stringify({
                version: 1,
                transitionId,
                state: 'committed',
                workingCopyPath: resolvedWorkingCopyPath,
                targetDocumentRevisionToken: transitionEvent.token,
                undoPdfPath: pdfBackupPath,
                undoCatalogPath: catalogBackupPath,
                undoCatalogExisted: catalogBackupExisted,
                committedAt: Date.now(),
            }), 'utf8');
        } finally {
            await Promise.all([
                ...(transitionPublished ? [] : [unlink(pdfBackupPath).catch(() => undefined)]),
                ...(transitionPublished ? [] : [rm(catalogBackupPath, {
                    recursive: true,
                    force: true,
                }).catch(() => undefined)]),
                ...(transitionPublished ? [] : [unlink(journalPath).catch(() => undefined)]),
            ]);
        }
        if (shouldRefreshOriginalSaveBase) {
            if (!await refreshWorkingCopyOriginalFileExpectation(resolvedWorkingCopyPath, senderId)) {
                throw new Error('Working copy registration changed before original expectation refresh completed');
            }
        }
        return true;
    });
}

export async function handleFileWriteDocx(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    data: unknown,
) {
    const senderId = requireSenderId(context);
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const payload = normalizeIpcWritePayload(data);
    if (!consumeAllowedDocxWritePath(normalizedPath, senderId)) {
        throw new Error('Invalid file path: DOCX writes must use a path from Save dialog');
    }

    await writeFileAtomic(resolve(normalizedPath), payload);
    return true;
}
