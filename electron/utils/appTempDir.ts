import { app } from 'electron';
import {
    chmodSync,
    lstatSync,
    mkdirSync,
} from 'fs';
import {
    join,
    win32,
} from 'path';
import { isErrnoException } from '@contracts/runtimeGuards';

const APP_TEMP_DIR_NAME = 'evb-viewer';

export function getAppTempDirPath() {
    const tempDir = app.getPath('temp');
    return /^[a-zA-Z]:[\\/]/.test(tempDir) || tempDir.startsWith('\\\\')
        ? win32.join(tempDir, APP_TEMP_DIR_NAME)
        : join(tempDir, APP_TEMP_DIR_NAME);
}

export function getAppTempDir() {
    const tempDir = getAppTempDirPath();
    try {
        if (lstatSync(tempDir).isSymbolicLink()) {
            throw new Error(`App temp directory must not be a symbolic link: ${tempDir}`);
        }
    } catch (error) {
        if (!isErrnoException(error) || error.code !== 'ENOENT') {
            throw error;
        }
    }
    mkdirSync(tempDir, { recursive: true });
    if (lstatSync(tempDir).isSymbolicLink()) {
        throw new Error(`App temp directory must not be a symbolic link: ${tempDir}`);
    }
    chmodSync(tempDir, 0o700);
    return tempDir;
}
