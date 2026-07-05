import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdir,
    readdir,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
    collectLiveDefaultDevSessionBlockers,
    formatLiveDefaultDevSessionError,
} from '@tests/e2e/electron/globalSetup';
import type {
    ISessionInfo,
    ISessionStartingInfo,
} from '@scripts/electron-run/electronRunSessionTypes';
import {
    type IFixtureDescribeSelector,
    resolveDjvuFixturePath,
    resolvePathFixtureAvailability,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';

const ELECTRON_FIXTURE_ROOT = join(process.cwd(), 'tests/fixtures/electron');
const MAX_TRACKED_ELECTRON_BINARY_FIXTURE_BYTES = 2 * 1024 * 1024;

async function collectFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            return collectFiles(path);
        }
        return entry.isFile() ? [path] : [];
    }));
    return files.flat();
}

function createDescribeSelectorDouble() {
    const skipSelector = ((_name: string, _fn: () => void) => undefined) as IFixtureDescribeSelector;
    skipSelector.skip = skipSelector;

    const selector = ((_name: string, _fn: () => void) => undefined) as IFixtureDescribeSelector;
    selector.skip = skipSelector;
    return selector;
}

function createReadySessionInfo(overrides: Partial<ISessionInfo> = {}): ISessionInfo {
    return {
        port: 39001,
        pid: 101,
        cdpPort: 39002,
        electronPid: 102,
        nuxtPid: 103,
        nuxtPort: 3235,
        runId: null,
        ...overrides,
    };
}

function createStartingSessionInfo(overrides: Partial<ISessionStartingInfo> = {}): ISessionStartingInfo {
    return {
        pid: 201,
        startedAt: 10_000,
        electronPids: [
            202,
            203,
        ],
        cdpPorts: [39003],
        electronUserDataDir: null,
        nuxtPid: 204,
        nuxtPort: 3235,
        runId: null,
        ...overrides,
    };
}

describe('Electron E2E fixture policy', () => {
    it('reports an optional missing fixture once and returns the skipped suite selector', () => {
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const describeLike = createDescribeSelectorDouble();

        try {
            const fixture = resolvePathFixtureAvailability({
                path: '.devkit/definitely-missing-fixture.pdf',
                label: 'missing unit-test',
                requiredEnvVar: 'EVB_UNIT_REQUIRE_MISSING_FIXTURE',
            });

            const firstSelector = selectFixtureDescribe(describeLike, fixture);
            const secondSelector = selectFixtureDescribe(describeLike, fixture);

            expect(firstSelector).toBe(describeLike.skip);
            expect(secondSelector).toBe(describeLike.skip);
            expect(infoSpy).toHaveBeenCalledTimes(1);
            expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('SKIPPED (fixture missing): missing unit-test fixture does not exist:'));
        } finally {
            infoSpy.mockRestore();
        }
    });

    it('fails during suite selection when the selected lane requires a missing fixture', () => {
        const previousValue = process.env.EVB_UNIT_REQUIRE_MISSING_FIXTURE;
        process.env.EVB_UNIT_REQUIRE_MISSING_FIXTURE = '1';
        const describeLike = createDescribeSelectorDouble();

        try {
            const fixture = resolvePathFixtureAvailability({
                path: '.devkit/definitely-missing-required-fixture.pdf',
                label: 'required unit-test',
                requiredEnvVar: 'EVB_UNIT_REQUIRE_MISSING_FIXTURE',
            });

            expect(() => selectFixtureDescribe(describeLike, fixture)).toThrow(
                /Required fixture missing: required unit-test fixture does not exist:/,
            );
        } finally {
            if (previousValue === undefined) {
                delete process.env.EVB_UNIT_REQUIRE_MISSING_FIXTURE;
            } else {
                process.env.EVB_UNIT_REQUIRE_MISSING_FIXTURE = previousValue;
            }
        }
    });

    it('resolves DjVu smoke through explicit, tracked, or generated deterministic fixtures only', async () => {
        const fixture = resolveDjvuFixturePath({
            devkitFixtureDir: '.devkit/tmp/unit-missing-djvu/devkit',
            env: {},
            generate: false,
            trackedFixtureDir: '.devkit/tmp/unit-missing-djvu/tracked',
        });

        expect(fixture).toMatchObject({
            path: null,
            required: false,
        });
        expect(fixture.reason).toContain('EVB_E2E_DJVU_FIXTURE');
        expect(fixture.reason).toContain('djvu-fixtures/viewer-smoke.djvu');
        expect(fixture.reason).not.toContain('.devkit/pdfs');

        const generatedFixturePath = join(process.cwd(), '.devkit/tmp/unit-missing-djvu/generated.djvu');
        await mkdir(join(process.cwd(), '.devkit/tmp/unit-missing-djvu'), { recursive: true });
        await writeFile(generatedFixturePath, 'generated fixture placeholder');
        try {
            const generated = resolveDjvuFixturePath({
                devkitFixtureDir: '.devkit/tmp/unit-missing-djvu/devkit',
                env: {},
                generatedFixtureFactory: () => generatedFixturePath,
                trackedFixtureDir: '.devkit/tmp/unit-missing-djvu/tracked',
            });
            expect(generated).toMatchObject({
                path: generatedFixturePath,
                reason: `Using generated DjVu fixture: ${generatedFixturePath}`,
                required: false,
            });
        } finally {
            await rm(join(process.cwd(), '.devkit/tmp/unit-missing-djvu'), {
                force: true,
                recursive: true,
            });
        }
    });

    it('keeps native-preview and DjVu fixture binaries out of tracked oversized fixtures', async () => {
        const files = await collectFiles(ELECTRON_FIXTURE_ROOT);
        const offenders: string[] = [];

        for (const file of files) {
            const relativePath = file.replace(`${ELECTRON_FIXTURE_ROOT}/`, '');
            const size = (await stat(file)).size;
            if (
                /\.(?:pdf|djvu|djv)$/i.test(relativePath)
                && size > MAX_TRACKED_ELECTRON_BINARY_FIXTURE_BYTES
            ) {
                offenders.push(`${relativePath} (${size} bytes)`);
            }
            if (
                /\.(?:djvu|djv)$/i.test(relativePath)
                && !relativePath.startsWith('djvu-fixtures/')
            ) {
                offenders.push(`${relativePath} (DjVu fixtures must live under djvu-fixtures/)`);
            }
            if (
                relativePath.startsWith('large-pdf-fixtures/')
                && !relativePath.endsWith('.md')
            ) {
                offenders.push(`${relativePath} (large native-preview PDFs must stay local-only)`);
            }
        }

        expect(offenders).toEqual([]);
    });

    it('keeps rapid PDF navigation self-sufficient instead of silently skipped', async () => {
        const source = await readFile('tests/e2e/electron/rapidPdfNavigation.e2e.test.ts', 'utf8');

        expect(source).toContain('createMultiPageTextFixturePdf');
        expect(source).not.toContain('selectFixtureDescribe');
        expect(source).not.toContain('EVB_E2E_REQUIRE_PAGE_JUMP_FIXTURE');
    });

    it('keeps large native preview explicitly opt-in instead of requiring a huge tracked PDF', async () => {
        const source = await readFile('tests/e2e/electron/largePdfNativePreview.e2e.test.ts', 'utf8');

        expect(source).toContain('PDFJS_NATIVE_PREVIEW_MIN_BYTES');
        expect(source).toContain('EVB_E2E_REQUIRE_NATIVE_LARGE_PDF_FIXTURE');
        expect(source).toContain('Set EVB_E2E_LARGE_PDF_FIXTURE to an oversized PDF');
    });
});

describe('Electron E2E deterministic isolation policy', () => {
    it('blocks a live default session before Electron E2E global setup starts shared infrastructure', () => {
        const livePids = new Set([
            101,
            103,
        ]);
        const blockers = collectLiveDefaultDevSessionBlockers({
            isAlive: pid => livePids.has(pid),
            ownPids: [999],
            sessionInfo: createReadySessionInfo(),
            startingInfo: null,
        });

        expect(blockers).toEqual([
            {
                label: 'session manager',
                pid: 101,
                source: 'ready',
            },
            {
                label: 'Nuxt dev server',
                pid: 103,
                source: 'ready',
            },
        ]);
        expect(formatLiveDefaultDevSessionError(blockers))
            .toContain('pnpm electron:run stop --session=default');
    });

    it('blocks fresh default startup attempts and ignores stale starting metadata', () => {
        const livePids = new Set([
            201,
            202,
            204,
        ]);
        const freshBlockers = collectLiveDefaultDevSessionBlockers({
            isAlive: pid => livePids.has(pid),
            nowMs: 11_000,
            ownPids: [999],
            sessionInfo: null,
            startingInfo: createStartingSessionInfo(),
            startingMaxAgeMs: 5_000,
        });

        expect(freshBlockers).toEqual([
            {
                label: 'starting session manager',
                pid: 201,
                source: 'starting',
            },
            {
                label: 'starting Electron app',
                pid: 202,
                source: 'starting',
            },
            {
                label: 'starting Nuxt dev server',
                pid: 204,
                source: 'starting',
            },
        ]);

        const staleBlockers = collectLiveDefaultDevSessionBlockers({
            isAlive: pid => livePids.has(pid),
            nowMs: 20_000,
            ownPids: [999],
            sessionInfo: null,
            startingInfo: createStartingSessionInfo(),
            startingMaxAgeMs: 5_000,
        });
        expect(staleBlockers).toEqual([]);
    });
});
