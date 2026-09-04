import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface IWindowsTestCliIo {
    write(line: string): void;
    writeError(line: string): void;
}

export function createProcessCliIo(): IWindowsTestCliIo {
    return {
        write: (line) => {
            process.stdout.write(`${line}\n`);
        },
        writeError: (line) => {
            process.stderr.write(`${line}\n`);
        },
    };
}

export function writeCliLines(io: IWindowsTestCliIo, lines: readonly string[]) {
    for (const line of lines) {
        io.write(line);
    }
}

/**
 * True only when Node started with this module as the script argument, so the
 * CLI modules can be imported by tests without running their entry point.
 */
export async function isDirectCliInvocation(moduleUrl: string, argv: readonly string[] = process.argv) {
    const entry = argv[1];
    if (entry === undefined) {
        return false;
    }
    const canonicalEntryPath = await realpath(path.resolve(entry)).catch(() => null);
    if (canonicalEntryPath === null) {
        return false;
    }
    return canonicalEntryPath === await realpath(fileURLToPath(moduleUrl));
}
