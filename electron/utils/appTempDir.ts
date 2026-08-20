import type { App } from 'electron';
import * as electron from 'electron';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    lstatSync,
    mkdirSync,
} from 'fs';
import {
    join,
    win32,
} from 'path';
import { tmpdir } from 'os';
import { isErrnoException } from '@contracts/runtimeGuards';

const APP_TEMP_DIR_NAME = 'evb-viewer';
const APP_TEMP_NAMESPACE_ENV = 'EVB_APP_TEMP_NAMESPACE';
const SAFE_NAMESPACE_PATTERN = /^[a-z\d][a-z\d-]{0,63}$/u;

export function createAppTempNamespace(userDataPath: string) {
    const normalizedPath = process.platform === 'win32'
        ? userDataPath.trim().replaceAll('\\', '/').toLowerCase()
        : userDataPath.trim();
    if (!normalizedPath) {
        throw new Error('App temp namespace requires a non-empty userData path.');
    }
    const userId = typeof process.getuid === 'function'
        ? `u${String(process.getuid())}`
        : 'user';
    const profileHash = createHash('sha256').update(normalizedPath).digest('hex').slice(0, 16);
    return `${userId}-${profileHash}`;
}

export function initializeAppTempNamespace(userDataPath: string) {
    const namespace = createAppTempNamespace(userDataPath);
    process.env[APP_TEMP_NAMESPACE_ENV] = namespace;
    return namespace;
}

function getAppTempNamespace() {
    const configuredNamespace = process.env[APP_TEMP_NAMESPACE_ENV]?.trim().toLowerCase();
    if (configuredNamespace && SAFE_NAMESPACE_PATTERN.test(configuredNamespace)) {
        return configuredNamespace;
    }

    const userDataPath = (electron as {app?: Pick<App, 'getPath'>}).app?.getPath('userData')?.trim();
    if (userDataPath) {
        return createAppTempNamespace(userDataPath);
    }

    const userId = typeof process.getuid === 'function'
        ? `u${String(process.getuid())}`
        : 'user';
    return `${userId}-fallback`;
}

function getOperatingSystemTempDir() {
    // Electron is unavailable inside Node worker_threads. Keep this utility
    // worker-safe because native document operations use it for managed
    // scratch output before publishing changes to a working copy.
    return (electron as {app?: Pick<App, 'getPath'>}).app?.getPath('temp') ?? tmpdir();
}

function joinTempDirectory(tempDir: string, directoryName: string) {
    return /^[a-zA-Z]:[\\/]/.test(tempDir) || tempDir.startsWith('\\\\')
        ? win32.join(tempDir, directoryName)
        : join(tempDir, directoryName);
}

/**
 * Returns the shared root used by releases predating per-profile temp
 * namespaces. It is exposed only for narrowly scoped migration cleanup; new
 * files and general temp-path authorization must use getAppTempDirPath().
 */
export function getLegacyAppTempDirPath() {
    return joinTempDirectory(getOperatingSystemTempDir(), APP_TEMP_DIR_NAME);
}

export function getAppTempDirPath() {
    const tempDir = getOperatingSystemTempDir();
    const namespacedDirectory = `${APP_TEMP_DIR_NAME}-${getAppTempNamespace()}`;
    return joinTempDirectory(tempDir, namespacedDirectory);
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
