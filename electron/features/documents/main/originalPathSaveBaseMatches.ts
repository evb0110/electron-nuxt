import {
    readFile,
    stat,
} from 'fs/promises';
import { getWorkingCopyOriginalFileExpectation } from '@electron/file-access/workingCopyStore';

async function originalPathMatchesStoredExpectation(
    originalPath: string,
    expectedOriginal: NonNullable<ReturnType<typeof getWorkingCopyOriginalFileExpectation>>,
) {
    const originalStat = await stat(originalPath);
    return (
        originalStat.size === expectedOriginal.size
        && originalStat.mtimeMs === expectedOriginal.mtimeMs
    );
}

async function originalPathMatchesWorkingCopyBytes(
    originalPath: string,
    workingPath: string,
) {
    const [
        originalStat,
        workingStat,
    ] = await Promise.all([
        stat(originalPath),
        stat(workingPath),
    ]);
    if (originalStat.size !== workingStat.size) {
        return false;
    }

    const [
        originalBytes,
        workingBytes,
    ] = await Promise.all([
        readFile(originalPath),
        readFile(workingPath),
    ]);
    return originalBytes.equals(workingBytes);
}

export async function originalPathSaveBaseMatches(
    workingPath: string,
    originalPath: string,
    senderWebContentsId: number,
) {
    const expectedOriginal = getWorkingCopyOriginalFileExpectation(workingPath, senderWebContentsId);
    if (!expectedOriginal) {
        return true;
    }
    if (await originalPathMatchesStoredExpectation(originalPath, expectedOriginal)) {
        return true;
    }

    return originalPathMatchesWorkingCopyBytes(originalPath, workingPath);
}
