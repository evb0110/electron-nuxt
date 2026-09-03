import {
    readFileSync,
    readdirSync,
} from 'node:fs';
import {
    extname,
    join,
    resolve,
} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createLandingFailureReporter,
    landingFailureReporter,
} from '@landing/server/utils/landingFailureReporter';

const projectRoot = process.cwd();
const landingRoot = resolve(projectRoot, 'landing');
const landingSourceExtensions = new Set([
    '.cjs',
    '.cts',
    '.env',
    '.example',
    '.js',
    '.json',
    '.md',
    '.mjs',
    '.mts',
    '.ts',
    '.tsx',
    '.vue',
    '.yaml',
    '.yml',
]);
const generatedLandingDirectories = new Set([
    '.nuxt',
    '.output',
    'dist',
    'node_modules',
]);

function isLandingSourceFile(fileName: string): boolean {
    return landingSourceExtensions.has(extname(fileName))
        || fileName === '.env'
        || fileName.startsWith('.env.');
}

interface ILandingSource {
    path: string
    source: string
}

function readLandingSources(directory: string): ILandingSource[] {
    return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
        if (entry.isDirectory()) {
            if (generatedLandingDirectories.has(entry.name)) {
                return [];
            }
            return readLandingSources(join(directory, entry.name));
        }

        if (!isLandingSourceFile(entry.name)) {
            return [];
        }

        const path = join(directory, entry.name);
        return [{
            path,
            source: readFileSync(path, 'utf8'),
        }];
    });
}

const landingSources = readLandingSources(landingRoot);

const createInput = () => ({
    code: 'UNCLASSIFIED_MAIN_ERROR' as const,
    context: {
        attempt: 1,
        phase: 'operation' as const,
        recovered: false,
    },
    local: {
        cause: {secret: 'local-cause-sentinel'},
        data: {secret: 'local-data-sentinel'},
        message: 'local-message-sentinel',
        source: 'landing-test',
    },
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('landing failure reporter', () => {
    it('returns a receipt while the default adapter makes no network request', () => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);

        const receipt = landingFailureReporter.capture(createInput());

        expect(receipt).toMatchObject({
            code: 'UNCLASSIFIED_MAIN_ERROR',
            severity: 'error',
        });
        expect(receipt.eventId).toMatch(/^[0-9a-f]{32}$/u);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('passes only a closed landing-nitro record to an injected adapter', () => {
        const send = vi.fn();
        const reporter = createLandingFailureReporter({send});

        reporter.capture(createInput());

        expect(send).toHaveBeenCalledOnce();
        const record = send.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
        expect(record).toMatchObject({
            code: 'UNCLASSIFIED_MAIN_ERROR',
            context: {
                attempt: 1,
                phase: 'operation',
                recovered: false,
            },
            frames: [],
            runtime: 'landing-nitro',
            schemaVersion: 1,
        });
        expect(record).not.toHaveProperty('local');
        expect(JSON.stringify(record)).not.toContain('local-message-sentinel');
        expect(JSON.stringify(record)).not.toContain('local-cause-sentinel');
        expect(JSON.stringify(record)).not.toContain('local-data-sentinel');
    });

    it('does not let an adapter failure escape capture', () => {
        const reporter = createLandingFailureReporter({send: () => {
            throw new Error('adapter unavailable');
        }});

        expect(() => reporter.capture(createInput())).not.toThrow();
    });
});

describe('landing telemetry boundary', () => {
    it('contains no Sentry package import or DSN reference', () => {
        for (const {
            path,
            source,
        } of landingSources) {
            expect(source, path).not.toMatch(/@sentry(?:[/'"]|$)/iu);
            expect(source, path).not.toMatch(/\b(?:sentry[_-]?)?dsn\b/iu);
            expect(source, path).not.toMatch(/https?:\/\/[^/\s"'`]+@[^/\s"'`]+\/\d+(?:[/?#][^\s"'`]*)?/iu);
        }
    });

    it('keeps the handled release and analytics failures at warning level', () => {
        const warningOnlyPaths = [
            'landing/server/api/releases/latest.get.ts',
            'landing/server/api/analytics/download.post.ts',
            'landing/server/api/analytics/pageView.post.ts',
        ];

        for (const relativePath of warningOnlyPaths) {
            const source = readFileSync(resolve(projectRoot, relativePath), 'utf8');
            expect(source, relativePath).toContain('console.warn');
            expect(source, relativePath).not.toContain('console.error');
        }
    });
});
