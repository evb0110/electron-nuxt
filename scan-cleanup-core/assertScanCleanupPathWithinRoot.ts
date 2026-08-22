import {
    lstatSync,
    realpathSync,
    statSync,
} from 'fs';
import {
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
    sep,
} from 'path';
import {ScanCleanupContractError} from '@scan-cleanup-core/errors';

function isMissingEntry(error: unknown) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Resolve the deepest ancestor that exists and re-append the missing tail, so a
 * destination that has not been created yet is still judged by the real
 * directory it would land in rather than by its spelling.
 */
function canonicalizeThroughExistingAncestor(candidatePath: string, label: string) {
    const missingSegments: string[] = [];
    let ancestor = candidatePath;
    for (;;) {
        try {
            lstatSync(ancestor);
        } catch (error) {
            if (!isMissingEntry(error)) {
                throw new ScanCleanupContractError(`${label} cannot be resolved`);
            }
            const parent = dirname(ancestor);
            if (parent === ancestor) {
                throw new ScanCleanupContractError(`${label} has no existing ancestor`);
            }
            missingSegments.unshift(basename(ancestor));
            ancestor = parent;
            continue;
        }
        let canonicalAncestor: string;
        try {
            canonicalAncestor = realpathSync(ancestor);
        } catch {
            // The segment exists as a link but does not resolve: a dangling or
            // looping symlink names no directory this root can vouch for.
            throw new ScanCleanupContractError(`${label} contains an unresolved symlink`);
        }
        return missingSegments.length === 0
            ? canonicalAncestor
            : join(canonicalAncestor, ...missingSegments);
    }
}

function canonicalizeRoot(rootPath: string, label: string) {
    let canonicalRoot: string;
    let isDirectory: boolean;
    try {
        canonicalRoot = realpathSync(rootPath);
        isDirectory = statSync(canonicalRoot).isDirectory();
    } catch {
        throw new ScanCleanupContractError(`${label} allowed root does not exist: ${rootPath}`);
    }
    if (!isDirectory) {
        throw new ScanCleanupContractError(`${label} allowed root is not a directory: ${rootPath}`);
    }
    return canonicalRoot;
}

export function assertScanCleanupPathWithinRoot(
    candidatePath: string,
    rootPath: string,
    label: string,
) {
    if (!isAbsolute(candidatePath) || !isAbsolute(rootPath)) {
        throw new ScanCleanupContractError(`${label} must be an absolute path`);
    }
    const canonicalRoot = canonicalizeRoot(rootPath, label);
    const canonicalCandidate = canonicalizeThroughExistingAncestor(candidatePath, label);
    const relativePath = relative(canonicalRoot, canonicalCandidate);
    if (
        relativePath === '..'
        || relativePath.startsWith(`..${sep}`)
        || isAbsolute(relativePath)
    ) {
        throw new ScanCleanupContractError(`${label} is outside its allowed root`);
    }
}
