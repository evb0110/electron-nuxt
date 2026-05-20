import type {
    ChildProcess,
    SpawnOptions,
} from 'child_process';
import { terminateProcessTree } from '@electron/utils/processTree';

export function shouldUseDetachedProcessGroup(platform: NodeJS.Platform = process.platform): boolean {
    return platform !== 'win32';
}

export function createDetachedChildProcessSpawnOptions(
    options: SpawnOptions = {},
    platform: NodeJS.Platform = process.platform,
): SpawnOptions {
    return {
        ...options,
        detached: shouldUseDetachedProcessGroup(platform),
    };
}

export async function terminateDetachedChildProcess(
    proc: ChildProcess,
    graceMs: number,
    platform: NodeJS.Platform = process.platform,
) {
    const pid = proc.pid;
    if (typeof pid === 'number' && Number.isFinite(pid) && pid > 0) {
        await terminateProcessTree(pid, {
            graceMs,
            preferProcessGroup: shouldUseDetachedProcessGroup(platform),
        });
        return;
    }

    try {
        proc.kill('SIGTERM');
    } catch {
        // Process may already be gone.
    }
}
