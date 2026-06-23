import { safeDestr } from 'destr';
import type { TDocumentRef } from '@contracts/documentRef';
import { getDocumentsCapability } from '@app/utils/platformDocuments';

function isAbsoluteOrDrivePath(value: string) {
    return value.startsWith('/')
        || value.startsWith('\\')
        || /^[a-zA-Z]:/.test(value);
}

function normalizeOcrArtifactRelativePath(relativePath: string) {
    const trimmedPath = relativePath.trim();
    if (!trimmedPath || isAbsoluteOrDrivePath(trimmedPath)) {
        return null;
    }

    const parts = trimmedPath
        .split(/[\\/]+/u)
        .filter(Boolean);
    if (
        parts.length === 0
        || parts.some(part => part === '.' || part === '..')
    ) {
        return null;
    }

    return parts.join('/');
}

function normalizeAdjacentArtifactSuffix(suffix: string) {
    const trimmedSuffix = suffix.trim();
    if (
        !trimmedSuffix.startsWith('.')
        || trimmedSuffix.includes('/')
        || trimmedSuffix.includes('\\')
        || trimmedSuffix.includes('..')
        || isAbsoluteOrDrivePath(trimmedSuffix)
    ) {
        return null;
    }

    return trimmedSuffix;
}

export async function readOptionalOcrArtifactJson<T>(
    workingCopyPath: TDocumentRef,
    relativePath: string,
): Promise<T | null> {
    const normalizedRelativePath = normalizeOcrArtifactRelativePath(relativePath);
    if (normalizedRelativePath === null) {
        return null;
    }

    const path = `${workingCopyPath}.ocr/${normalizedRelativePath}`;
    const documents = getDocumentsCapability();
    const exists = await documents.fileExists(path);
    if (!exists) {
        return null;
    }

    return safeDestr<T>(await documents.readTextFile(path));
}

export async function readOptionalAdjacentJsonArtifact<T>(
    workingCopyPath: TDocumentRef,
    suffix: string,
): Promise<T | null> {
    const normalizedSuffix = normalizeAdjacentArtifactSuffix(suffix);
    if (normalizedSuffix === null) {
        return null;
    }

    const path = `${workingCopyPath}${normalizedSuffix}`;
    const documents = getDocumentsCapability();
    const exists = await documents.fileExists(path);
    if (!exists) {
        return null;
    }

    return safeDestr<T>(await documents.readTextFile(path));
}
