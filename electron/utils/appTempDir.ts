import { app } from 'electron';
import { mkdirSync } from 'fs';
import {
    join,
    win32,
} from 'path';

const APP_TEMP_DIR_NAME = 'evb-viewer';

export function getAppTempDirPath() {
    const tempDir = app.getPath('temp');
    return /^[a-zA-Z]:[\\/]/.test(tempDir) || tempDir.startsWith('\\\\')
        ? win32.join(tempDir, APP_TEMP_DIR_NAME)
        : join(tempDir, APP_TEMP_DIR_NAME);
}

export function getAppTempDir() {
    const tempDir = getAppTempDirPath();
    mkdirSync(tempDir, { recursive: true });
    return tempDir;
}
