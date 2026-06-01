import { safeDestr } from 'destr';
import type { TDocumentRef } from '@contracts/platformApi';
import { readBrowserOcrArtifactJson } from '@app/platform/browser-api/browserOcrArtifactStore';
import { isBrowserDocumentRef } from '@app/platform/browserDocumentStore';
import { getDocumentsCapability } from '@app/utils/platformDocuments';

export async function readOptionalOcrArtifactJson<T>(
    workingCopyPath: TDocumentRef,
    relativePath: string,
): Promise<T | null> {
    if (isBrowserDocumentRef(workingCopyPath)) {
        try {
            const browserArtifact = await readBrowserOcrArtifactJson(workingCopyPath, relativePath);
            if (browserArtifact !== null) {
                return browserArtifact as T;
            }
        } catch {
            // Fall through to adjacent artifact lookup for host-provided stores.
        }
    }

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
