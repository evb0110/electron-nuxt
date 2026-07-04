import type { IDocumentMutationRevisionOptions } from '@contracts/electronApiDocuments';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {
    assertWorkingCopyMutationAllowed,
    assertWorkingCopyRevisionCurrent,
} from '@electron/file-access/documentRevisionStore';

export function normalizeExpectedDocumentRevisionToken(
    options?: IDocumentMutationRevisionOptions | null,
): TDocumentRevisionToken | null {
    const token = options?.expectedDocumentRevisionToken;
    if (token === undefined || token === null) {
        return null;
    }
    if (typeof token !== 'string' || token.trim().length === 0) {
        throw new TypeError('expectedDocumentRevisionToken must be a non-empty string');
    }
    return token.trim();
}

export async function assertQueuedWorkingCopyMutationPreconditions(
    workingCopyPath: string,
    expectedDocumentRevisionToken?: TDocumentRevisionToken | null,
) {
    assertWorkingCopyMutationAllowed(workingCopyPath);
    if (expectedDocumentRevisionToken) {
        await assertWorkingCopyRevisionCurrent(workingCopyPath, expectedDocumentRevisionToken);
    }
}
