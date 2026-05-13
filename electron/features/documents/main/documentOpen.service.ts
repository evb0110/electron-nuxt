import { existsSync } from 'fs';
import { basename } from 'path';
import {
    buildCombinedPdfOutputPath,
    createPdfFromInputPaths,
    type ICreatePdfFromInputPathsProgress,
    isDjvuPath,
    isPdfPath,
    isSupportedOpenPath,
} from '@electron/image/pdfConversion';
import {
    createWorkingCopy,
    createWorkingCopyFromData,
} from '@electron/ipc/workingCopy';
import {
    allowOpenPaths,
    requireOpenPath,
} from '@electron/ipc/openPathCapabilities';
import { te } from '@electron/i18n';
import { createLogger } from '@electron/utils/logger';
import { normalizeNonEmptyStringPaths } from '@contracts/shared';
import { addRecentInputs } from '@electron/features/documents/main/recentInputs.service';

const logger = createLogger('documents-open-service');

type TOpenPathOwner = number | Electron.WebContents;

interface IOpenPdfResult {
    kind: 'pdf';
    workingPath: string;
    originalPath: string;
    isGenerated?: boolean;
}

interface IOpenDjvuResult {
    kind: 'djvu';
    workingPath: '';
    originalPath: string;
}

export type IOpenFileResult = IOpenPdfResult | IOpenDjvuResult;

interface IOpenInputPathsOptions {onCombineProgress?: (progress: ICreatePdfFromInputPathsProgress) => void;}

function toRecentDocumentPaths(paths: string[]) {
    return paths.filter(path => isPdfPath(path) || isDjvuPath(path));
}

export async function openInputPaths(
    paths: string[],
    options: IOpenInputPathsOptions = {},
    owner?: TOpenPathOwner,
): Promise<IOpenFileResult | null> {
    const normalizedPaths = normalizeNonEmptyStringPaths(paths);
    logger.info(`openInputPaths normalized ${normalizedPaths.length} path(s): ${normalizedPaths.join(' | ')}`);
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
        logger.info(`openInputPaths resolved DjVu path: ${djvuPath}`);
        await addRecentInputs([djvuPath], owner);
        return {
            kind: 'djvu',
            workingPath: '',
            originalPath: trustedDjvuPath,
        };
    }

    if (normalizedPaths.length === 1 && isPdfPath(normalizedPaths[0]!)) {
        const originalPath = normalizedPaths[0]!;
        logger.info(`openInputPaths creating working copy for PDF: ${originalPath}`);
        const workingPath = await createWorkingCopy(requireOpenPath(originalPath, owner));
        await addRecentInputs([originalPath], owner);
        return {
            kind: 'pdf',
            workingPath,
            originalPath,
        };
    }

    const mergedPdf = await createPdfFromInputPaths(normalizedPaths, {onProgress: options.onCombineProgress});
    const outputPath = buildCombinedPdfOutputPath(normalizedPaths);
    logger.info(`openInputPaths created combined PDF for batch; output: ${outputPath}`);
    const workingPath = await createWorkingCopyFromData(
        basename(outputPath),
        mergedPdf,
        outputPath,
    );

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
