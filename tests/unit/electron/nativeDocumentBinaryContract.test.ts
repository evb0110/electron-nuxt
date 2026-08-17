import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
    describe,
    expect,
    it,
} from 'vitest';

const execFileAsync = promisify(execFile);
const hostResourceDirectory = `${process.platform}-${process.arch}`;
const executableSuffix = process.platform === 'win32' ? '.exe' : '';
const hostIsPackaged = [
    'darwin-arm64',
    'linux-x64',
    'win32-x64',
].includes(hostResourceDirectory);
const nativeToolCommandTimeoutMs = 15_000;
const nativeToolContractTestTimeoutMs = nativeToolCommandTimeoutMs + 5_000;

function nativeToolPath(tool: 'ddjvu' | 'djvused' | 'pdftotext' | 'qpdf') {
    const packageName = tool === 'qpdf'
        ? 'qpdf'
        : tool === 'pdftotext'
            ? 'poppler'
            : 'djvulibre';
    return resolve(
        process.cwd(),
        'resources',
        packageName,
        hostResourceDirectory,
        'bin',
        `${tool}${executableSuffix}`,
    );
}

describe.skipIf(!hostIsPackaged)('shipped native document binary contracts', () => {
    it('keeps qpdf JSON compatible with the JavaScript page contract', async () => {
        const fixture = resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf');
        const {stdout} = await execFileAsync(nativeToolPath('qpdf'), [
            '--json',
            fixture,
        ], {
            maxBuffer: 8 * 1024 * 1024,
            timeout: nativeToolCommandTimeoutMs,
        });
        const result = JSON.parse(stdout) as {
            pages?: unknown[];
            qpdf?: unknown;
            version?: number
        };

        expect(result.version).toBe(2);
        expect(result.pages).toHaveLength(1);
        expect(result.qpdf).toBeTruthy();
    }, nativeToolContractTestTimeoutMs);

    it('keeps pdftotext output compatible with the JavaScript text contract', async () => {
        const fixture = resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf');
        const {stdout} = await execFileAsync(nativeToolPath('pdftotext'), [
            fixture,
            '-',
        ], {timeout: nativeToolCommandTimeoutMs});

        expect(stdout).toContain('Hello Arabic world');
        expect(stdout).toContain('First');
        expect(stdout).toContain('Second text box');
    }, nativeToolContractTestTimeoutMs);

    it('runs the shipped DjVuLibre command-line pair', async () => {
        const captureStderr = (error: unknown) => ({stderr: error && typeof error === 'object' && 'stderr' in error
            ? String(error.stderr)
            : String(error)});
        const [
            ddjvuHelpResult,
            djvusedVersionResult,
        ] = await Promise.all([
            execFileAsync(nativeToolPath('ddjvu'), ['--help'], {timeout: nativeToolCommandTimeoutMs}).catch((error: unknown) => ({stderr: error && typeof error === 'object' && 'stderr' in error
                ? String(error.stderr)
                : String(error)})),
            execFileAsync(nativeToolPath('djvused'), ['--version'], {timeout: nativeToolCommandTimeoutMs}).catch(captureStderr),
        ]);

        expect(ddjvuHelpResult.stderr).toContain('Usage: ddjvu');
        expect(djvusedVersionResult.stderr).toContain('DjVuLibre-');
    }, nativeToolContractTestTimeoutMs);
});
