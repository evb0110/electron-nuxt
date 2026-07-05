import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import { createMissingRevisionError } from '@contracts/documentMutationErrors';
import {
    assertWorkingCopyMutationAllowed,
    assertWorkingCopyRevisionCurrent,
} from '@electron/file-access/documentRevisionStore';

export function normalizeExpectedDocumentRevisionToken(
    options?: {expectedDocumentRevisionToken?: TDocumentRevisionToken | null} | null,
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
    if (expectedDocumentRevisionToken === undefined || expectedDocumentRevisionToken === null) {
        throw createMissingRevisionError({documentRef: workingCopyPath});
    }
    await assertWorkingCopyRevisionCurrent(workingCopyPath, expectedDocumentRevisionToken);
}

export function assertQueuedWorkingCopyMutationPreconditionsForBootstrap(
    workingCopyPath: string,
    reason: string,
) {
    if (reason.trim().length === 0) {
        throw new TypeError('bootstrap mutation precondition reason must be a non-empty string');
    }
    assertWorkingCopyMutationAllowed(workingCopyPath);
}
