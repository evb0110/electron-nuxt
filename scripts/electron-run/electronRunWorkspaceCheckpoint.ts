import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { electronUserDataPath } from '@scripts/electron-run/electronRunSessionPaths';

const WORKSPACE_CRASH_CHECKPOINT_FILE_NAME = 'workspace-checkpoint.json';

export function workspaceCrashCheckpointPath(name: string) {
    return join(electronUserDataPath(name), WORKSPACE_CRASH_CHECKPOINT_FILE_NAME);
}

export function clearAutomationWorkspaceCrashCheckpoint(name: string) {
    try {
        unlinkSync(workspaceCrashCheckpointPath(name));
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}
