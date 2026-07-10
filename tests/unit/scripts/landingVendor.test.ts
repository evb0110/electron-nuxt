import {
    join,
    resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    mkdtempSync,
    mkdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';

interface ISyncVendorResult {
    count: number;
    drifted: string[];
    skipped?: string;
}

interface ILandingVendorModule {
    syncVendor: (options?: {
        check?: boolean;
        landingRoot?: string;
        repoPackages?: string;
    }) => ISyncVendorResult;
    transformVendoredSource: (source: string) => string;
}

const {
    syncVendor,
    transformVendoredSource,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'landing/scripts/vendor.mjs')).href
) as ILandingVendorModule;

describe('landing vendor sync', () => {
    const tmpRoots: string[] = [];

    afterEach(() => {
        for (const root of tmpRoots) {
            rmSync(root, {
                recursive: true,
                force: true,
            });
        }
        tmpRoots.length = 0;
    });

    it('rewrites package imports for the self-contained landing app', () => {
        expect(transformVendoredSource([
            'import { format } from "@evb/i18n-core/messageFormat";',
            'import { selectRelease } from "@evb/releaseSelection/releaseSelection";',
            'import { retry } from "@evb/releaseSelection/latestReleaseRetry";',
        ].join('\n'))).toBe([
            'import { format } from "./messageFormat";',
            'import { selectRelease } from "./releaseSelection";',
            'import { retry } from "./latestReleaseRetry";',
        ].join('\n'));
    });

    it('allows vendor checks in self-contained deployment archives', () => {
        const root = mkdtempSync(join(tmpdir(), 'landing-vendor-'));
        tmpRoots.push(root);

        for (const file of [
            'vendor/contracts/release.ts',
            'vendor/contracts/runtimeGuards.ts',
            'vendor/i18n-core/index.ts',
            'vendor/release-selection/index.ts',
        ]) {
            const path = join(root, file);
            mkdirSync(resolve(path, '..'), {recursive: true});
            writeFileSync(path, '', 'utf8');
        }

        expect(syncVendor({
            check: true,
            landingRoot: root,
            repoPackages: join(root, 'missing-packages'),
        })).toMatchObject({
            count: 0,
            drifted: [],
            skipped: expect.stringContaining('source packages are unavailable'),
        });
    });

    it('detects drift in every file from the canonical manifest', () => {
        const root = mkdtempSync(join(tmpdir(), 'landing-vendor-manifest-'));
        tmpRoots.push(root);
        const landingRoot = join(root, 'landing');
        const repoPackages = join(root, 'packages');

        for (const file of [
            'contracts/release.ts',
            'contracts/runtimeGuards.ts',
            'i18n-core/index.ts',
            'release-selection/index.ts',
        ]) {
            const path = join(repoPackages, file);
            mkdirSync(resolve(path, '..'), {recursive: true});
            writeFileSync(path, `export const source = '${file}';\n`, 'utf8');
        }

        expect(syncVendor({
            landingRoot,
            repoPackages,
        })).toMatchObject({count: 4});

        writeFileSync(
            join(repoPackages, 'contracts/runtimeGuards.ts'),
            'export const source = "changed";\n',
            'utf8',
        );

        expect(() => syncVendor({
            check: true,
            landingRoot,
            repoPackages,
        })).toThrow('vendor/contracts/runtimeGuards.ts');
    });
});
