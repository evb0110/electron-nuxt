import {
    chmod,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const temporaryDirectories: string[] = [];

async function createWrongProtocolService() {
    const directory = await mkdtemp(join(tmpdir(), 'evb-search-service-'));
    temporaryDirectories.push(directory);
    const markerPath = join(directory, 'starts.txt');
    const executablePath = join(directory, 'evb-pdf-search');
    await writeFile(executablePath, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(markerPath)}, 'started\\n');
process.stderr.write('x'.repeat(70 * 1024) + ' diagnostic-tail\\n');
setTimeout(() => process.stdout.write(JSON.stringify({type: 'ready', protocolVersion: 99}) + '\\n'), 20);
process.stdin.resume();
`, 'utf8');
    await chmod(executablePath, 0o755);
    return {
        executablePath,
        markerPath,
    };
}

async function createSearchService(source: string) {
    const directory = await mkdtemp(join(tmpdir(), 'evb-search-service-'));
    temporaryDirectories.push(directory);
    const executablePath = join(directory, 'evb-pdf-search');
    await writeFile(executablePath, `#!/usr/bin/env node\n${source}\n`, 'utf8');
    await chmod(executablePath, 0o755);
    return executablePath;
}

const request = {
    contextChars: 4,
    documentRevision: 'revision-1',
    indexPath: '/tmp/unused-search-index',
    limit: 10,
    matchCase: false,
    pageCount: 1,
    query: 'needle',
};

describe('persistent native search service', () => {
    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
            force: true,
            recursive: true,
        })));
    });

    it('rejects a mismatched daemon protocol immediately, retains bounded stderr, and evicts the daemon', async () => {
        vi.stubEnv('EVB_PDF_SEARCH_SERVICE_ENABLE', '1');
        const {
            executablePath,
            markerPath,
        } = await createWrongProtocolService();
        const {tryRunPersistentNativeSearch} = await import('@electron/search/tryRunPersistentNativeSearch');
        const startedAt = Date.now();
        await expect(tryRunPersistentNativeSearch(executablePath, request, {timeoutMs: 1_000}))
            .rejects.toThrow(/protocol mismatch: expected 1, got 99; \[native stderr truncated to 65536 bytes\] native stderr: .*diagnostic-tail/u);
        expect(Date.now() - startedAt).toBeLessThan(4_500);

        await expect(tryRunPersistentNativeSearch(executablePath, request, {timeoutMs: 1_000}))
            .rejects.toThrow('protocol mismatch: expected 1, got 99');
        expect((await readFile(markerPath, 'utf8')).trim().split('\n')).toHaveLength(2);
    });

    it('honors cancellation while daemon startup is still pending', async () => {
        vi.stubEnv('EVB_PDF_SEARCH_SERVICE_ENABLE', '1');
        const executablePath = await createSearchService(`
setTimeout(() => process.stdout.write(JSON.stringify({type: 'ready', protocolVersion: 1}) + '\\n'), 250);
setTimeout(() => process.exit(0), 500);
process.stdin.resume();
`);
        const {tryRunPersistentNativeSearch} = await import('@electron/search/tryRunPersistentNativeSearch');
        const controller = new AbortController();
        const result = tryRunPersistentNativeSearch(executablePath, request, {
            signal: controller.signal,
            timeoutMs: 1_000,
        });
        controller.abort();

        await expect(result).rejects.toThrow('Native search canceled');
    });

    it('settles a timed-out request even when the daemon has closed stdin', async () => {
        vi.stubEnv('EVB_PDF_SEARCH_SERVICE_ENABLE', '1');
        const executablePath = await createSearchService(`
process.stdout.write(JSON.stringify({type: 'ready', protocolVersion: 1}) + '\\n');
process.stdin.destroy();
setTimeout(() => process.exit(0), 500);
`);
        const {tryRunPersistentNativeSearch} = await import('@electron/search/tryRunPersistentNativeSearch');

        await expect(tryRunPersistentNativeSearch(executablePath, request, {timeoutMs: 30}))
            .rejects.toThrow(/request timeout|unavailable|EPIPE/u);
    });

    it('does not apply the service idle timeout while a request is pending', async () => {
        vi.stubEnv('EVB_PDF_SEARCH_SERVICE_ENABLE', '1');
        vi.stubEnv('EVB_PDF_SEARCH_SERVICE_IDLE_TIMEOUT_MS', '30');
        const executablePath = await createSearchService(`
const readline = require('node:readline');
process.stdout.write(JSON.stringify({type: 'ready', protocolVersion: 1}) + '\\n');
readline.createInterface({input: process.stdin}).on('line', line => {
    const frame = JSON.parse(line);
    if (frame.type !== 'search') return;
    setTimeout(() => process.stdout.write(JSON.stringify({
        type: 'result',
        requestId: frame.requestId,
        result: {results: []}
    }) + '\\n'), 100);
});
`);
        const {tryRunPersistentNativeSearch} = await import('@electron/search/tryRunPersistentNativeSearch');

        await expect(tryRunPersistentNativeSearch(executablePath, request, {timeoutMs: 500}))
            .resolves.toEqual({results: []});
    });
});
