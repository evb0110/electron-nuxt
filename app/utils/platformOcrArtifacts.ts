import { safeDestr } from 'destr';
import type { TDocumentRef } from '@contracts/platformApi';
import { getDocumentsCapability } from '@app/utils/platformDocuments';

export async function readOptionalOcrArtifactJson<T>(
    workingCopyPath: TDocumentRef,
    relativePath: string,
): Promise<T | null> {
    const path = `${workingCopyPath}.ocr/${relativePath}`;
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
    const path = `${workingCopyPath}${suffix}`;
    const documents = getDocumentsCapability();
    const exists = await documents.fileExists(path);
    if (!exists) {
        return null;
    }

    return safeDestr<T>(await documents.readTextFile(path));
}
