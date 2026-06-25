import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    mkdir,
    mkdtemp,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';

const {
    checkSourceFileSize,
    checkSourceFileSizes,
    countPhysicalLines,
    normalizePath,
    shouldScanSourcePath,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/architecture/source-size-check.mjs')).href);

function lines(count: number) {
    return Array.from({ length: count }, (_, index) => `export const line${index} = ${index};`).join('\n') + '\n';
}

async function createTempProject() {
    return mkdtemp(join(tmpdir(), 'evb-source-size-'));
}

async function writeProjectFile(projectRoot: string, filePath: string, text: string) {
    const absolutePath = join(projectRoot, filePath);
    await mkdir(join(absolutePath, '..'), { recursive: true });
    await writeFile(absolutePath, text);
}

describe('source-size architecture check', () => {
    it('normalizes paths and counts physical lines', () => {
        expect(normalizePath('app\\modules\\file.ts')).toBe('app/modules/file.ts');
        expect(countPhysicalLines('')).toBe(0);
        expect(countPhysicalLines('one')).toBe(1);
        expect(countPhysicalLines('one\ntwo\n')).toBe(2);
    });

    it('fails unallowlisted source files over the threshold', () => {
        expect(checkSourceFileSize({
            filePath: 'app/modules/example/big.ts',
            lineCount: 4,
            threshold: 3,
            allowlist: {},
        })).toMatchObject({
            rule: 'source-size-threshold',
            file: 'app/modules/example/big.ts',
            lineCount: 4,
            maxLines: 3,
        });
    });

    it('allows budgeted files at budget and fails growth or stale slack', () => {
        const allowlist = {'app/modules/example/known.ts': {
            maxLines: 5,
            reason: 'known hotspot',
            stage: 'test stage',
        }};

        expect(checkSourceFileSize({
            filePath: 'app/modules/example/known.ts',
            lineCount: 5,
            threshold: 3,
            allowlist,
        })).toBeNull();
        expect(checkSourceFileSize({
            filePath: 'app/modules/example/known.ts',
            lineCount: 4,
            threshold: 3,
            allowlist,
        })).toMatchObject({
            rule: 'source-size-allowlist-budget-slack',
            file: 'app/modules/example/known.ts',
            lineCount: 4,
            maxLines: 5,
        });
        expect(checkSourceFileSize({
            filePath: 'app/modules/example/known.ts',
            lineCount: 6,
            threshold: 3,
            allowlist,
        })).toMatchObject({
            rule: 'source-size-allowlist-growth',
            file: 'app/modules/example/known.ts',
            lineCount: 6,
            maxLines: 5,
        });
    });

    it('ignores vendor, locale, test, and generated paths', async () => {
        const projectRoot = await createTempProject();
        await writeProjectFile(projectRoot, 'app/assets/css/vendor/pdfjs-viewer-sanitized.ts', lines(10));
        await writeProjectFile(projectRoot, 'packages/i18n-app/messages/ru.ts', lines(10));
        await writeProjectFile(projectRoot, 'app/modules/example/tests/large.test.ts', lines(10));
        await writeProjectFile(projectRoot, 'app/modules/example/generated/large.ts', lines(10));

        const result = await checkSourceFileSizes({
            projectRoot,
            roots: [
                'app',
                'packages/i18n-app',
            ],
            threshold: 3,
            allowlist: {},
        });

        expect(result).toEqual({
            scannedFiles: 0,
            violations: [],
        });
    });

    it('scans source-like paths and reports stable sorted violations', async () => {
        const projectRoot = await createTempProject();
        await writeProjectFile(projectRoot, 'app/modules/zeta/big.ts', lines(5));
        await writeProjectFile(projectRoot, 'app/modules/alpha/big.vue', lines(4));
        await writeProjectFile(projectRoot, 'app/modules/alpha/ignored.md', lines(5));
        await writeProjectFile(projectRoot, 'app/modules/alpha/small.ts', lines(2));

        const result = await checkSourceFileSizes({
            projectRoot,
            roots: ['app'],
            threshold: 3,
            allowlist: {},
        });

        expect(result.violations.map((violation: { file: string }) => violation.file)).toEqual([
            'app/modules/alpha/big.vue',
            'app/modules/zeta/big.ts',
        ]);
    });

    it('filters source paths before scanning', () => {
        expect(shouldScanSourcePath('app/modules/example/file.ts')).toBe(true);
        expect(shouldScanSourcePath('app/modules/example/file.md')).toBe(false);
        expect(shouldScanSourcePath('tests/unit/example.test.ts')).toBe(false);
        expect(shouldScanSourcePath('packages/i18n-app/messages/en.ts')).toBe(false);
    });
});
