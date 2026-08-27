import { randomUUID } from 'node:crypto';
import {spawn} from 'node:child_process';
import {
    constants as fsConstants,
    existsSync,
    mkdirSync,
} from 'fs';
import {
    copyFile,
    rm,
} from 'fs/promises';
import {join} from 'path';
import { isErrnoException } from '@contracts/runtimeGuards';
import { getAppTempDir } from '@electron/utils/appTempDir';

const COPY_ON_WRITE_FALLBACK_CODES = new Set([
    'ENOTSUP',
    'EOPNOTSUPP',
    'ENOSYS',
    'EINVAL',
    'EXDEV',
]);
const MAC_CLONE_TIMEOUT_MS = 30_000;

export type TWorkingCopyCloneAttemptOutcome =
    | 'cloned'
    | 'known-unsupported'
    | 'unknown-error-eager-fallback';

function isCopyOnWriteUnavailable(error: unknown) {
    return isErrnoException(error)
        && typeof error.code === 'string'
        && COPY_ON_WRITE_FALLBACK_CODES.has(error.code);
}

function shouldUseMacCloneHelper() {
    if (process.env.EVB_TEST_FORCE_MAC_CLONE_HELPER === '1') {
        return true;
    }
    return process.platform === 'darwin'
        && process.env.EVB_TEST_DISABLE_MAC_CLONE_HELPER !== '1';
}

async function copyFileWithMacClone(sourcePath: string, targetPath: string) {
    return new Promise<boolean>((resolveClone) => {
        const child = spawn('/bin/cp', [
            '-c',
            '--',
            sourcePath,
            targetPath,
        ], {
            stdio: 'ignore',
            windowsHide: true,
        });
        let settled = false;
        const finish = (cloned: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            resolveClone(cloned);
        };
        const timeout = setTimeout(() => {
            child.kill('SIGKILL');
            finish(false);
        }, MAC_CLONE_TIMEOUT_MS);
        timeout.unref();
        child.once('error', () => finish(false));
        child.once('exit', code => finish(code === 0));
    });
}

export function createWorkingDirectory() {
    const tempDir = getAppTempDir();
    const workDir = join(tempDir, `pdf-work-${randomUUID()}`);
    mkdirSync(workDir, { recursive: true });
    return workDir;
}

export function isWorkingCopyDirectoryName(name: string) {
    return name.startsWith('pdf-work-');
}

export async function safeRemoveDirectory(path: string) {
    if (!existsSync(path)) {
        return false;
    }

    try {
        await rm(path, {
            recursive: true,
            force: true,
        });
        return true;
    } catch {
        return false;
    }
}

function getForcedCloneOutcomeForTests() {
    if (process.env.NODE_ENV !== 'test') {
        return null;
    }
    const forcedOutcome = process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT;
    return forcedOutcome === 'success' || forcedOutcome === 'unsupported'
        ? forcedOutcome
        : null;
}

export async function attemptWorkingCopyClone(
    sourcePath: string,
    targetPath: string,
): Promise<TWorkingCopyCloneAttemptOutcome> {
    const forcedOutcome = getForcedCloneOutcomeForTests();
    if (forcedOutcome === 'unsupported') {
        return 'known-unsupported';
    }
    if (forcedOutcome === 'success') {
        await copyFile(sourcePath, targetPath);
        return 'cloned';
    }

    if (shouldUseMacCloneHelper()) {
        if (await copyFileWithMacClone(sourcePath, targetPath)) {
            return 'cloned';
        }
        await rm(targetPath, {force: true}).catch(() => undefined);
        return 'known-unsupported';
    }

    try {
        await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_FICLONE_FORCE);
        return 'cloned';
    } catch (error) {
        await rm(targetPath, {force: true}).catch(() => undefined);
        if (isCopyOnWriteUnavailable(error)) {
            return 'known-unsupported';
        }
    }

    await copyFile(sourcePath, targetPath);
    return 'unknown-error-eager-fallback';
}

export async function copyFileCopyOnWrite(sourcePath: string, targetPath: string) {
    const outcome = await attemptWorkingCopyClone(sourcePath, targetPath);
    if (outcome === 'known-unsupported') {
        await copyFile(sourcePath, targetPath);
    }
}
