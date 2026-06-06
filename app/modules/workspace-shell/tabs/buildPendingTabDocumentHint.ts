import type {
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platformApi';
import type { IRecentFile } from '@contracts/shared';
import type { TTabUpdate } from '@app/types/tabs';
import { getDocumentRefBaseName } from '@app/utils/documentRef';

type TOpenDocumentTarget = TDocumentRef | TOpenFileResult | IRecentFile;

function isOpenFileResult(target: TOpenDocumentTarget): target is TOpenFileResult {
    return typeof target === 'object' && 'kind' in target;
}

function isRecentFile(target: TOpenDocumentTarget): target is IRecentFile {
    return typeof target === 'object' && 'fileName' in target && 'timestamp' in target;
}

function isDjvuDocumentPath(path: TDocumentRef | null | undefined, fileName: string | null) {
    return /\.djvu?$/iu.test(fileName ?? path ?? '');
}

export function buildPendingTabDocumentHint(target: TOpenDocumentTarget): TTabUpdate {
    if (typeof target === 'string') {
        const fileName = getDocumentRefBaseName(target);
        return {
            fileName,
            originalPath: target,
            isDjvu: isDjvuDocumentPath(target, fileName),
        };
    }

    if (isRecentFile(target)) {
        const fileName = target.fileName || getDocumentRefBaseName(target.originalPath);
        return {
            fileName,
            originalPath: target.originalPath,
            isDjvu: isDjvuDocumentPath(target.originalPath, fileName),
        };
    }

    if (isOpenFileResult(target)) {
        const sourcePath = target.originalPath || (target.kind === 'pdf' ? target.workingPath : '');
        return {
            fileName: getDocumentRefBaseName(sourcePath),
            originalPath: target.originalPath,
            isDjvu: target.kind === 'djvu',
        };
    }

    return {};
}
