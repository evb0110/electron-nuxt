import { execFile } from 'child_process';
import { existsSync } from 'fs';
import {
    readFile,
    readdir,
    stat,
} from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import {
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const DIST_DIR = join(REPO_ROOT, 'dist-electron');
const ELECTRON_DIR = join(REPO_ROOT, 'electron');

interface IBundleCheck {
    file: string;
    requiredSymbols: string[];
}

const BUNDLE_CHECKS: IBundleCheck[] = [
    {
        file: 'pdf-combine-worker.js',
        requiredSymbols: [
            'readImageDpi',
            'pixelsToPdfPoints',
            'readTiffFrameDpi',
            'METERS_PER_INCH',
        ],
    },
    {
        file: 'ocr-worker.js',
        requiredSymbols: ['detectSourceDpi'],
    },
];

let latestSourceMtimeMs = 0;

async function collectTypeScriptFiles(dirPath: string): Promise<string[]> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        const entryPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectTypeScriptFiles(entryPath));
            continue;
        }
        if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts'))) {
            files.push(entryPath);
        }
    }

    return files;
}

async function getLatestSourceMtimeMs(): Promise<number> {
    const sourceFiles = await collectTypeScriptFiles(ELECTRON_DIR);
    const freshnessReferenceFiles = [
        ...sourceFiles,
        join(REPO_ROOT, 'package.json'),
    ];

    let newestMtimeMs = 0;
    for (const sourceFile of freshnessReferenceFiles) {
        const sourceStat = await stat(sourceFile);
        newestMtimeMs = Math.max(newestMtimeMs, sourceStat.mtimeMs);
    }

    return newestMtimeMs;
}

async function rebuildElectronBundlesIfStale() {
    latestSourceMtimeMs = await getLatestSourceMtimeMs();

    const staleBundleFiles: string[] = [];
    for (const check of BUNDLE_CHECKS) {
        const bundlePath = join(DIST_DIR, check.file);
        if (!existsSync(bundlePath)) {
            staleBundleFiles.push(check.file);
            continue;
        }

        const bundleStat = await stat(bundlePath);
        if (bundleStat.mtimeMs < latestSourceMtimeMs) {
            staleBundleFiles.push(check.file);
        }
    }

    if (staleBundleFiles.length === 0) {
        return;
    }

    const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    await execFileAsync(
        pnpmCommand,
        [
            'run',
            'build:electron',
        ],
        {
            cwd: REPO_ROOT,
            env: process.env,
        },
    );

    for (const check of BUNDLE_CHECKS) {
        const bundlePath = join(DIST_DIR, check.file);
        if (!existsSync(bundlePath)) {
            throw new Error(`${check.file} not found after "pnpm run build:electron"`);
        }

        const bundleStat = await stat(bundlePath);
        if (bundleStat.mtimeMs < latestSourceMtimeMs) {
            throw new Error(`${check.file} is still stale after "pnpm run build:electron"`);
        }
    }
}

describe('electron bundle integrity', () => {
    beforeAll(async () => {
        await rebuildElectronBundlesIfStale();
    }, 180_000);

    for (const check of BUNDLE_CHECKS) {
        describe(check.file, () => {
            const bundlePath = join(DIST_DIR, check.file);

            it('exists in dist-electron', () => {
                expect(existsSync(bundlePath), `${check.file} not found — run "pnpm run build:electron"`).toBe(true);
            });

            it('is not stale relative to electron sources', async () => {
                if (!existsSync(bundlePath)) {
                    throw new Error(`${check.file} not found — run "pnpm run build:electron"`);
                }

                const bundleStat = await stat(bundlePath);
                expect(
                    bundleStat.mtimeMs,
                    `${check.file} appears stale compared to electron sources — run "pnpm run build:electron"`,
                ).toBeGreaterThanOrEqual(latestSourceMtimeMs);
            });

            for (const symbol of check.requiredSymbols) {
                it(`contains "${symbol}"`, async () => {
                    if (!existsSync(bundlePath)) {
                        throw new Error(`${check.file} not found — run "pnpm run build:electron"`);
                    }
                    const content = await readFile(bundlePath, 'utf-8');
                    expect(
                        content.includes(symbol),
                        `${check.file} is missing "${symbol}" — rebuild with "pnpm run build:electron"`,
                    ).toBe(true);
                });
            }
        });
    }
});
