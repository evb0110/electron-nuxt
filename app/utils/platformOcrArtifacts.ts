import type { TDocumentRef } from '@contracts/documentRef';
import {
    safeJsonParse,
    type TJsonValidator,
} from '@contracts/safeJsonParse';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';

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

export async function readOptionalOcrArtifactJson(
    workingCopyPath: TDocumentRef,
    relativePath: string,
): Promise<unknown | null>;
export async function readOptionalOcrArtifactJson<T>(
    workingCopyPath: TDocumentRef,
    relativePath: string,
    validator: TJsonValidator<T>,
): Promise<T | null>;
export async function readOptionalOcrArtifactJson<T>(
    workingCopyPath: TDocumentRef,
    relativePath: string,
    validator?: TJsonValidator<T>,
) {
    const normalizedRelativePath = normalizeOcrArtifactRelativePath(relativePath);
    if (normalizedRelativePath === null) {
        return null;
    }

    const path = `${workingCopyPath}.ocr/${normalizedRelativePath}`;
    const documents = getDocumentFilesCapability();
    const exists = await documents.fileExists(path);
    if (!exists) {
        return null;
    }

    const source = await documents.readTextFile(path);
    return validator ? safeJsonParse(source, validator) : safeJsonParse(source);
}

export async function readOptionalAdjacentJsonArtifact(
    workingCopyPath: TDocumentRef,
    suffix: string,
): Promise<unknown | null>;
export async function readOptionalAdjacentJsonArtifact<T>(
    workingCopyPath: TDocumentRef,
    suffix: string,
    validator: TJsonValidator<T>,
): Promise<T | null>;
export async function readOptionalAdjacentJsonArtifact<T>(
    workingCopyPath: TDocumentRef,
    suffix: string,
    validator?: TJsonValidator<T>,
) {
    const normalizedSuffix = normalizeAdjacentArtifactSuffix(suffix);
    if (normalizedSuffix === null) {
        return null;
    }

    const path = `${workingCopyPath}${normalizedSuffix}`;
    const documents = getDocumentFilesCapability();
    const exists = await documents.fileExists(path);
    if (!exists) {
        return null;
    }

    const source = await documents.readTextFile(path);
    return validator ? safeJsonParse(source, validator) : safeJsonParse(source);
}
