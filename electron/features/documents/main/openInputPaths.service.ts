import { existsSync } from 'fs';
import {
    mkdtemp,
    rm,
} from 'fs/promises';
import { tmpdir } from 'os';
import {
    basename,
    join,
} from 'path';
import {
    buildCombinedPdfOutputPath,
    createPdfFileFromInputPaths,
    type ICreatePdfFromInputPathsProgress,
    isDjvuPath,
    isPdfPath,
    isSupportedOpenPath,
} from '@electron/image/pdfConversion';
import {
    createWorkingCopy,
    createWorkingCopyFromPath,
} from '@electron/file-access/workingCopyCreation';
import {
    allowOpenPaths,
    requireOpenPath,
} from '@electron/file-access/openPathCapabilities';
import { te } from '@electron/te';
import { createLogger } from '@electron/utils/createLogger';
import { normalizeNonEmptyStringPaths } from '@contracts/shared';
import { addRecentInputs } from '@electron/features/documents/main/addRecentInputs.service';
import { normalizePossiblyEncodedExistingPath } from '@electron/utils/normalizePossiblyEncodedExistingPath';
import type { TOpenFileResult } from '@electron/features/documents/contract';

const logger = createLogger('documents-open-service');

type TOpenPathOwner = number | Electron.WebContents;

interface IOpenInputPathsOptions {onCombineProgress?: (progress: ICreatePdfFromInputPathsProgress) => void;}

function toRecentDocumentPaths(paths: string[]) {
    return paths.filter(path => isPdfPath(path) || isDjvuPath(path));
}

function getOwnerWebContentsId(owner?: TOpenPathOwner) {
    if (typeof owner === 'number') {
        return owner;
    }
    return owner?.id;
}

export async function openInputPaths(
    paths: string[],
    options: IOpenInputPathsOptions = {},
    owner?: TOpenPathOwner,
): Promise<TOpenFileResult | null> {
    const normalizedPaths = normalizeNonEmptyStringPaths(paths)
        .map(path => normalizePossiblyEncodedExistingPath(path) ?? path);
    logger.debug(`openInputPaths normalized ${normalizedPaths.length} path(s): ${normalizedPaths.join(' | ')}`);
    if (normalizedPaths.length === 0) {
        return null;
    }

    if (normalizedPaths.some(path => !existsSync(path))) {
        throw new Error(te('errors.file.invalid'));
    }

    if (normalizedPaths.some(path => !isSupportedOpenPath(path))) {
        throw new Error(te('errors.file.invalid'));
    }

    allowOpenPaths(normalizedPaths, owner);

    const djvuPaths = normalizedPaths.filter(path => isDjvuPath(path));
    if (djvuPaths.length > 0 && normalizedPaths.length === 1 && djvuPaths.length === 1) {
        const djvuPath = djvuPaths[0]!;
        const trustedDjvuPath = requireOpenPath(djvuPath, owner);
        logger.debug(`openInputPaths resolved DjVu path: ${djvuPath}`);
        await addRecentInputs([djvuPath], owner);
        return {
            kind: 'djvu',
            workingPath: '',
            originalPath: trustedDjvuPath,
        };
    }

    if (normalizedPaths.length === 1 && isPdfPath(normalizedPaths[0]!)) {
        const originalPath = normalizedPaths[0]!;
        logger.debug(`openInputPaths creating working copy for PDF: ${originalPath}`);
        const workingPath = await createWorkingCopy(requireOpenPath(originalPath, owner), getOwnerWebContentsId(owner));
        await addRecentInputs([originalPath], owner);
        return {
            kind: 'pdf',
            workingPath,
            originalPath,
        };
    }

    const outputPath = buildCombinedPdfOutputPath(normalizedPaths);
    const tempDir = await mkdtemp(join(tmpdir(), 'pdf-combine-open-'));
    let workingPath: string;
    try {
        const tempOutputPath = join(tempDir, basename(outputPath));
        await createPdfFileFromInputPaths(
            normalizedPaths,
            tempOutputPath,
            {...(options.onCombineProgress ? { onProgress: options.onCombineProgress } : {})},
        );
        logger.info(`openInputPaths created combined PDF for batch; output: ${outputPath}`);
        allowOpenPaths([tempOutputPath], owner);
        const trustedTempOutputPath = requireOpenPath(tempOutputPath, owner);
        workingPath = await createWorkingCopyFromPath(
            trustedTempOutputPath,
            outputPath,
            getOwnerWebContentsId(owner),
        );
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }

    const recentDocumentPaths = toRecentDocumentPaths(normalizedPaths);
    if (recentDocumentPaths.length > 0) {
        await addRecentInputs(recentDocumentPaths, owner);
    }

    return {
        kind: 'pdf',
        workingPath,
        originalPath: outputPath,
        isGenerated: true,
    };
}
