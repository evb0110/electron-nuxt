import {
    relative,
    resolve,
    sep,
    isAbsolute,
} from 'path';
import {ScanCleanupContractError} from '@scan-cleanup-core/errors';

export function assertScanCleanupPathWithinRoot(
    candidatePath: string,
    rootPath: string,
    label: string,
) {
    if (!isAbsolute(candidatePath) || !isAbsolute(rootPath)) {
        throw new ScanCleanupContractError(`${label} must be an absolute path`);
    }
    const relativePath = relative(resolve(rootPath), resolve(candidatePath));
    if (
        relativePath === '..'
        || relativePath.startsWith(`..${sep}`)
        || isAbsolute(relativePath)
    ) {
        throw new ScanCleanupContractError(`${label} is outside its allowed root`);
    }
}
