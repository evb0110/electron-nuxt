import {
    buildDjvuRuntimeEnv,
    getDjvuToolPaths,
} from '@electron/djvu/paths';
import { runNativeCommand } from '@electron/native-tools/command-runner';
import { createLogger } from '@electron/utils/logger';

const logger = createLogger('djvu-metadata');

interface IRunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

const DJVU_METADATA_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_METADATA_TIMEOUT_MS ?? '20000', 10);
    if (!Number.isFinite(parsed) || parsed < 1_000) {
        return 20_000;
    }
    return parsed;
})();
const DJVU_METADATA_MAX_STDOUT_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_METADATA_MAX_STDOUT_BYTES ?? '262144', 10);
    if (!Number.isFinite(parsed) || parsed < 1_024) {
        return 262_144;
    }
    return parsed;
})();
const DJVU_METADATA_MAX_STDERR_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_METADATA_MAX_STDERR_BYTES ?? '131072', 10);
    if (!Number.isFinite(parsed) || parsed < 1_024) {
        return 131_072;
    }
    return parsed;
})();
const DJVU_MAX_PAGES = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_MAX_PAGES ?? '10000', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 10_000;
    }
    return Math.min(parsed, 100_000);
})();

async function runDjvused(args: string[]): Promise<IRunResult> {
    const { djvused } = getDjvuToolPaths();
    const result = await runNativeCommand(djvused, args, {
        env: buildDjvuRuntimeEnv(),
        timeoutMs: DJVU_METADATA_TIMEOUT_MS,
        maxStdoutBytes: DJVU_METADATA_MAX_STDOUT_BYTES,
        maxStderrBytes: DJVU_METADATA_MAX_STDERR_BYTES,
        commandLabel: 'djvused',
        defaultCwdToCommandDir: true,
        prependCommandDirToPath: true,
        includeProcessEnv: true,
        windowsHide: true,
    });

    return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
    };
}

export async function getDjvuPageCount(filePath: string): Promise<number> {
    const result = await runDjvused([
        filePath,
        '-e',
        'n',
    ]);
    const count = parseInt(result.stdout.trim(), 10);
    if (!Number.isFinite(count) || count <= 0) {
        throw new Error(`Invalid page count from djvused: ${result.stdout.trim()}`);
    }
    if (count > DJVU_MAX_PAGES) {
        throw new Error(`DjVu page count ${count} exceeds supported limit (${DJVU_MAX_PAGES})`);
    }
    return count;
}

export async function getDjvuOutline(filePath: string): Promise<string> {
    try {
        const result = await runDjvused([
            filePath,
            '-e',
            'print-outline',
        ]);
        return result.stdout.trim();
    } catch (error) {
        logger.debug(`Failed to read DjVu outline for ${filePath}: ${String(error)}`);
        return '';
    }
}

export async function getDjvuMetadata(filePath: string): Promise<Record<string, string>> {
    try {
        const result = await runDjvused([
            filePath,
            '-e',
            'print-meta',
        ]);
        const metadata: Record<string, string> = {};
        const lines = result.stdout.trim().split('\n');
        for (const line of lines) {
            const match = line.match(/^(\w+)\s+"((?:[^"\\]|\\.)*)"/);
            if (match && match[1] && match[2]) {
                metadata[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            }
        }
        return metadata;
    } catch (error) {
        logger.debug(`Failed to read DjVu metadata for ${filePath}: ${String(error)}`);
        return {};
    }
}

export async function getDjvuResolution(filePath: string): Promise<number> {
    try {
        const result = await runDjvused([
            filePath,
            '-e',
            'select 1; print-dpi',
        ]);
        const dpi = parseInt(result.stdout.trim(), 10);
        return Number.isFinite(dpi) && dpi > 0 ? dpi : 300;
    } catch (error) {
        logger.debug(`Failed to read DjVu resolution for ${filePath}: ${String(error)}`);
        return 300;
    }
}

export async function getDjvuHasText(filePath: string): Promise<boolean> {
    try {
        const result = await runDjvused([
            filePath,
            '-e',
            'select 1; print-txt',
        ]);
        return result.stdout.trim().length > 0;
    } catch (error) {
        logger.debug(`Failed to detect DjVu text layer for ${filePath}: ${String(error)}`);
        return false;
    }
}
