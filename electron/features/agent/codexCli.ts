import {
    constants,
    existsSync,
} from 'fs';
import {
    access,
    mkdir,
} from 'fs/promises';
import { spawn } from 'child_process';
import {
    delimiter,
    join,
} from 'path';
import { homedir } from 'os';
import { app } from 'electron';
import { getErrorMessage } from '@electron/utils/error';

export const CODEX_APP_INSTALL_URL = 'https://developers.openai.com/codex/app';
export const CODEX_STANDALONE_INSTALL_URL = process.platform === 'win32'
    ? 'https://chatgpt.com/codex/install.ps1'
    : 'https://chatgpt.com/codex/install.sh';
const MIN_CODEX_APP_SERVER_VERSION = '0.133.0';

const CODEX_COMMAND_TIMEOUT_MS = 15_000;
const CODEX_INSTALL_TIMEOUT_MS = 5 * 60_000;
const SHELL_DETECTION_TIMEOUT_MS = 5_000;
const CODEX_COMMAND_MAX_OUTPUT_CHARS = 256 * 1024;

interface ICodexCliCommandResult {
    ok: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
}

export interface ICodexCliInfo {
    installed: boolean;
    path: string | null;
    version: string | null;
    isVersionSupported: boolean;
    minimumVersion: string;
    managedInstallDir: string;
}

export interface IInstallCodexOptions {onProgress?: (message: string) => void;}

function getCodexExecutableName() {
    if (process.platform === 'win32') {
        return 'codex.cmd';
    }
    return 'codex';
}

function getWindowsCodexExecutableNames() {
    return [
        'codex.cmd',
        'codex.exe',
        'codex',
    ];
}

function getManagedCodexInstallDir() {
    try {
        return join(app.getPath('userData'), 'codex', 'bin');
    } catch {
        return join(homedir(), '.evb-viewer', 'codex', 'bin');
    }
}

function getManagedCodexPathCandidates() {
    const installDir = getManagedCodexInstallDir();
    if (process.platform === 'win32') {
        return getWindowsCodexExecutableNames().map(name => join(installDir, name));
    }
    return [join(installDir, getCodexExecutableName())];
}

function uniqueStrings(values: string[]) {
    return [...new Set(values.filter(value => value.trim().length > 0))];
}

function buildCodexPathCandidates() {
    const pathCandidates = (process.env.PATH ?? '')
        .split(delimiter)
        .flatMap(pathEntry => process.platform === 'win32'
            ? getWindowsCodexExecutableNames().map(name => join(pathEntry, name))
            : [join(pathEntry, getCodexExecutableName())]);

    const candidates = [
        process.env.CODEX_CLI_PATH,
        ...getManagedCodexPathCandidates(),
        process.platform === 'darwin'
            ? '/Applications/Codex.app/Contents/Resources/codex'
            : undefined,
        ...pathCandidates,
        join(homedir(), '.local', 'bin', getCodexExecutableName()),
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        '/usr/bin/codex',
    ];
    return uniqueStrings(candidates.flatMap(candidate => typeof candidate === 'string' ? [candidate] : []));
}

async function isExecutable(path: string) {
    if (!existsSync(path)) {
        return false;
    }

    if (process.platform === 'win32') {
        return true;
    }

    try {
        await access(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function runCommand(
    command: string,
    args: string[],
    timeoutMs = CODEX_COMMAND_TIMEOUT_MS,
    options: {
        env?: NodeJS.ProcessEnv;
        onStdout?: (chunk: string) => void;
        onStderr?: (chunk: string) => void;
    } = {},
): Promise<ICodexCliCommandResult> {
    const appendBoundedOutput = (existing: string, chunk: string) => {
        if (existing.length >= CODEX_COMMAND_MAX_OUTPUT_CHARS) {
            return existing;
        }
        return `${existing}${chunk}`.slice(0, CODEX_COMMAND_MAX_OUTPUT_CHARS);
    };
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            env: {
                ...process.env,
                NO_COLOR: '1',
                ...options.env,
            },
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timeout = setTimeout(() => {
            if (settled) {
                return;
            }
            child.kill();
            settled = true;
            resolve({
                ok: false,
                stdout,
                stderr: stderr || 'Command timed out.',
                exitCode: null,
            });
        }, timeoutMs);

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            stdout = appendBoundedOutput(stdout, chunk);
            options.onStdout?.(chunk);
        });
        child.stderr.on('data', (chunk: string) => {
            stderr = appendBoundedOutput(stderr, chunk);
            options.onStderr?.(chunk);
        });
        child.on('error', (error) => {
            if (settled) {
                return;
            }
            clearTimeout(timeout);
            settled = true;
            resolve({
                ok: false,
                stdout,
                stderr: getErrorMessage(error),
                exitCode: null,
            });
        });
        child.on('close', (exitCode) => {
            if (settled) {
                return;
            }
            clearTimeout(timeout);
            settled = true;
            resolve({
                ok: exitCode === 0,
                stdout,
                stderr,
                exitCode,
            });
        });
    });
}

async function findCodexInLoginShell() {
    if (process.platform === 'win32') {
        return null;
    }

    const shellPath = process.env.SHELL?.length ? process.env.SHELL : '/bin/zsh';
    if (!existsSync(shellPath)) {
        return null;
    }

    const result = await runCommand(shellPath, [
        '-lc',
        'command -v codex',
    ], SHELL_DETECTION_TIMEOUT_MS);
    const candidate = result.stdout.trim().split('\n')[0]?.trim();
    if (!candidate || !(await isExecutable(candidate))) {
        return null;
    }
    return candidate;
}

export async function resolveCodexCliPath() {
    for (const candidate of buildCodexPathCandidates()) {
        if (await isExecutable(candidate)) {
            return candidate;
        }
    }
    return findCodexInLoginShell();
}

export function runCodexCli(codexPath: string, args: string[]) {
    return runCommand(codexPath, args);
}

function parseCodexVersion(stdout: string) {
    const match = stdout.match(/(?:codex-cli\s+)?(\d+\.\d+\.\d+)/u);
    return match?.[1] ?? null;
}

function compareVersions(left: string, right: string) {
    const leftParts = left.split('.').map(part => Number.parseInt(part, 10));
    const rightParts = right.split('.').map(part => Number.parseInt(part, 10));
    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
        const rawLeftPart = leftParts[index];
        const rawRightPart = rightParts[index];
        const leftPart = typeof rawLeftPart === 'number' && Number.isFinite(rawLeftPart) ? rawLeftPart : 0;
        const rightPart = typeof rawRightPart === 'number' && Number.isFinite(rawRightPart) ? rawRightPart : 0;
        if (leftPart !== rightPart) {
            return leftPart - rightPart;
        }
    }
    return 0;
}

function isCodexVersionSupported(version: string | null) {
    return version !== null && compareVersions(version, MIN_CODEX_APP_SERVER_VERSION) >= 0;
}

export async function getCodexCliInfo(): Promise<ICodexCliInfo> {
    const codexPath = await resolveCodexCliPath();
    if (!codexPath) {
        return {
            installed: false,
            path: null,
            version: null,
            isVersionSupported: false,
            minimumVersion: MIN_CODEX_APP_SERVER_VERSION,
            managedInstallDir: getManagedCodexInstallDir(),
        };
    }

    const versionResult = await runCodexCli(codexPath, ['--version']);
    const version = versionResult.ok ? parseCodexVersion(versionResult.stdout || versionResult.stderr) : null;
    return {
        installed: true,
        path: codexPath,
        version,
        isVersionSupported: isCodexVersionSupported(version),
        minimumVersion: MIN_CODEX_APP_SERVER_VERSION,
        managedInstallDir: getManagedCodexInstallDir(),
    };
}

function createInstallProgressRelay(options: IInstallCodexOptions) {
    let pending = '';
    return (chunk: string) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/u);
        pending = lines.pop() ?? '';
        for (const line of lines) {
            const normalized = line.trim();
            if (normalized) {
                options.onProgress?.(normalized);
            }
        }
    };
}

export async function installManagedCodex(options: IInstallCodexOptions = {}) {
    const installDir = getManagedCodexInstallDir();
    await mkdir(installDir, { recursive: true });

    const relay = createInstallProgressRelay(options);
    const env = {
        CODEX_INSTALL_DIR: installDir,
        CODEX_NON_INTERACTIVE: '1',
    };
    const result = process.platform === 'win32'
        ? await runCommand(
            'powershell.exe',
            [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                `$ErrorActionPreference = 'Stop'; Invoke-WebRequest -UseBasicParsing '${CODEX_STANDALONE_INSTALL_URL}' | Invoke-Expression`,
            ],
            CODEX_INSTALL_TIMEOUT_MS,
            {
                env,
                onStdout: relay,
                onStderr: relay,
            },
        )
        : await runCommand(
            '/bin/sh',
            [
                '-c',
                `curl -fsSL '${CODEX_STANDALONE_INSTALL_URL}' | sh`,
            ],
            CODEX_INSTALL_TIMEOUT_MS,
            {
                env,
                onStdout: relay,
                onStderr: relay,
            },
        );

    if (!result.ok) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || 'Codex installation failed.');
    }

    return getCodexCliInfo();
}
