import {
    describe,
    expect,
    it,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { GENERATED_RUST_NATIVE_TOOL_PROTOCOLS } from '@contracts/nativeToolProtocols';
import {
    createReleaseTargetManifest,
    PACKAGED_ENTRY_FIELD_SEPARATOR,
} from '@scripts/generateReleaseTargetManifest';
import {
    ELECTRON_BUILDER_PLATFORM_KEYS,
    GLOBAL_PACKAGED_RESOURCES,
    type getPackagedNativeToolFamilies,
    NATIVE_RESOURCE_PLATFORM_ARCHES,
} from '@scripts/nativeResourceManifest';

const requireScript = createRequire(import.meta.url);
const {
    renderPackagedEntries,
    validateReleaseTargetManifest,
} = requireScript(
    resolve(process.cwd(), 'scripts/release/generated-release-targets.cjs'),
) as {
    renderPackagedEntries: (tag: string) => string;
    validateReleaseTargetManifest: (value: unknown) => unknown;
};

const {
    assertMacPackagedToolSmoke,
    getMacPackagedToolSmokePolicy,
    RELEASE_TARGET_MANIFEST,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/release/native-tool-smoke-policy.mjs')).href
) as {
    assertMacPackagedToolSmoke: (toolName: string, exitCode: number, output: string) => void;
    getMacPackagedToolSmokePolicy: (toolName: string) => {
        allowedExitCodes: ReadonlySet<number>;
        expectedOutputTokens: readonly string[];
    };
    RELEASE_TARGET_MANIFEST: {
        families: ReturnType<typeof getPackagedNativeToolFamilies>;
        globalResources: typeof GLOBAL_PACKAGED_RESOURCES;
        platformArches: readonly string[];
        schemaVersion: number;
        electronBuilderPlatformKeys: typeof ELECTRON_BUILDER_PLATFORM_KEYS;
        signing: {
            entitlementsPathSegments: readonly string[];
            executableRoots: ReadonlyArray<readonly string[]>;
            platforms: readonly string[];
        };
    };
};

function manifestWithMutation(path: ReadonlyArray<number | string>, value: unknown) {
    const manifest: unknown = structuredClone(RELEASE_TARGET_MANIFEST);
    let cursor = manifest;
    for (const segment of path.slice(0, -1)) {
        if (typeof cursor !== 'object' || cursor === null) {
            throw new Error(`Cannot mutate manifest path: ${path.join('.')}`);
        }
        cursor = Reflect.get(cursor, String(segment));
    }
    if (typeof cursor !== 'object' || cursor === null) {
        throw new Error(`Cannot mutate manifest path: ${path.join('.')}`);
    }
    Reflect.set(cursor, String(path.at(-1)), value);
    return manifest;
}

describe('native tool smoke policy', () => {
    it.each([
        {
            branch: 'root schema',
            error: 'Invalid root',
            path: ['schemaVersion'],
            value: 2,
        },
        {
            branch: 'platform targets',
            error: 'Invalid platformArches',
            path: ['platformArches'],
            value: ['darwin-sparc'],
        },
        {
            branch: 'Electron Builder platform mapping',
            error: 'Invalid electronBuilderPlatformKeys',
            path: [
                'electronBuilderPlatformKeys',
                'darwin',
            ],
            value: 'win',
        },
        {
            branch: 'family identity',
            error: 'Invalid family',
            path: [
                'families',
                0,
                'id',
            ],
            value: '',
        },
        {
            branch: 'family label',
            error: 'Invalid family',
            path: [
                'families',
                0,
                'label',
            ],
            value: '',
        },
        {
            branch: 'family path',
            error: 'Invalid family',
            path: [
                'families',
                0,
                'sourceRootSegments',
            ],
            value: ['..'],
        },
        {
            branch: 'family protocol',
            error: 'Invalid family protocol',
            path: [
                'families',
                4,
                'protocolVersion',
            ],
            value: 1.5,
        },
        {
            branch: 'family binary name',
            error: 'Invalid family protocol',
            path: [
                'families',
                4,
                'binaryName',
            ],
            value: 42,
        },
        {
            branch: 'package filters',
            error: 'Invalid package filters',
            path: [
                'families',
                1,
                'packageFiltersByPlatform',
                'win32',
            ],
            value: [''],
        },
        {
            branch: 'entry identity',
            error: 'Invalid packaged entry',
            path: [
                'families',
                0,
                'packagedEntries',
                0,
                'id',
            ],
            value: '',
        },
        {
            branch: 'entry label',
            error: 'Invalid packaged entry',
            path: [
                'families',
                0,
                'packagedEntries',
                0,
                'label',
            ],
            value: '',
        },
        {
            branch: 'entry type',
            error: 'Invalid packaged entry',
            path: [
                'families',
                0,
                'packagedEntries',
                0,
                'type',
            ],
            value: 'pipe',
        },
        {
            branch: 'entry path',
            error: 'Invalid packaged entry',
            path: [
                'families',
                0,
                'packagedEntries',
                0,
                'pathSegments',
            ],
            value: ['../binary'],
        },
        {
            branch: 'entry platforms',
            error: 'Invalid packaged entry platforms',
            path: [
                'families',
                0,
                'packagedEntries',
                1,
                'platforms',
            ],
            value: ['android'],
        },
        {
            branch: 'entry skip reasons',
            error: 'Invalid packaged entry skip',
            path: [
                'families',
                0,
                'packagedEntries',
                1,
                'skip',
            ],
            value: {android: 'not packaged'},
        },
        {
            branch: 'global identity',
            error: 'Invalid global resource',
            path: [
                'globalResources',
                0,
                'id',
            ],
            value: '',
        },
        {
            branch: 'global label',
            error: 'Invalid global resource',
            path: [
                'globalResources',
                0,
                'label',
            ],
            value: '',
        },
        {
            branch: 'global type',
            error: 'Invalid global resource',
            path: [
                'globalResources',
                0,
                'type',
            ],
            value: 'pipe',
        },
        {
            branch: 'global path',
            error: 'Invalid global resource',
            path: [
                'globalResources',
                0,
                'stagedSegments',
            ],
            value: ['../tessdata'],
        },
        {
            branch: 'global filters',
            error: 'Invalid global resource',
            path: [
                'globalResources',
                0,
                'filters',
            ],
            value: [''],
        },
        {
            branch: 'signing platforms',
            error: 'Invalid signing inputs',
            path: [
                'signing',
                'platforms',
            ],
            value: ['android'],
        },
        {
            branch: 'signing entitlement path',
            error: 'Invalid signing inputs',
            path: [
                'signing',
                'entitlementsPathSegments',
            ],
            value: ['..'],
        },
        {
            branch: 'signing executable roots',
            error: 'Invalid signing inputs',
            path: [
                'signing',
                'executableRoots',
            ],
            value: [['other-root']],
        },
    ])('rejects invalid $branch at the disk trust boundary', ({
        error,
        path,
        value,
    }) => {
        expect(() => validateReleaseTargetManifest(
            manifestWithMutation(path, value),
        )).toThrow(error);
    });

    it('renders every manifest entry for each supported verifier target', () => {
        for (const tag of RELEASE_TARGET_MANIFEST.platformArches) {
            const platform = tag.split('-')[0] as 'darwin' | 'linux' | 'win32';
            const suffix = platform === 'win32' ? '.exe' : '';
            const expectedRows = RELEASE_TARGET_MANIFEST.families.flatMap(family => (
                family.packagedEntries
                    .filter(entry => !entry.skip?.[platform]
                        && (!entry.platforms || entry.platforms.includes(platform)))
                    .map(entry => [
                        'native',
                        family.stagedRootSegments.join('/'),
                        entry.pathSegments.join('/').replaceAll('{exeSuffix}', suffix),
                        entry.type,
                        entry.label,
                        entry.id,
                    ].join(PACKAGED_ENTRY_FIELD_SEPARATOR))
            ));
            expectedRows.push(...RELEASE_TARGET_MANIFEST.globalResources.map(resource => [
                'global',
                '',
                resource.stagedSegments.join('/'),
                resource.type,
                resource.label,
                resource.id,
            ].join(PACKAGED_ENTRY_FIELD_SEPARATOR)));

            expect(renderPackagedEntries(tag).split('\n')).toEqual(expectedRows);
        }
        expect(() => renderPackagedEntries('darwin-sparc')).toThrow(
            'Unsupported platform-arch: darwin-sparc',
        );
    });

    it('keeps mac packaged tool smoke expectations explicit per tool', () => {
        const verifierSource = readFileSync(resolve(process.cwd(), 'scripts/verify-packaged-native-tools.sh'), 'utf-8');
        const verifierTools = Array.from(
            verifierSource.matchAll(/run_macos_packaged_tool_smoke "([^"]+)"/gu),
            match => match[1],
        );
        const expectedPolicies = new Map<string, Set<number>>([
            [
                'ddjvu',
                new Set([
                    0,
                    1,
                    10,
                ]),
            ],
            [
                'djvused',
                new Set([
                    0,
                    10,
                ]),
            ],
            [
                'djvudump',
                new Set([
                    0,
                    1,
                    10,
                ]),
            ],
            [
                'evb-pdf-image-combine',
                new Set([0]),
            ],
            [
                'evb-pdf-image-combine-protocol',
                new Set([0]),
            ],
            [
                'evb-pdf-image-combine-compact-manifest',
                new Set([1]),
            ],
            [
                'evb-pdf-page-ops',
                new Set([0]),
            ],
            [
                'evb-pdf-search',
                new Set([0]),
            ],
            [
                'evb-scan-cleanup',
                new Set([0]),
            ],
            [
                'evb-scan-cleanup-protocol',
                new Set([0]),
            ],
            [
                'pdfinfo',
                new Set([0]),
            ],
            [
                'pdftoppm',
                new Set([0]),
            ],
            [
                'pdftotext',
                new Set([0]),
            ],
            [
                'qpdf',
                new Set([0]),
            ],
            [
                'tesseract',
                new Set([0]),
            ],
            [
                'unpaper',
                new Set([0]),
            ],
        ]);

        expect(verifierTools.sort()).toEqual(Array.from(expectedPolicies.keys()).sort());
        for (const [
            toolName,
            allowedExitCodes,
        ] of expectedPolicies) {
            expect(getMacPackagedToolSmokePolicy(toolName).allowedExitCodes).toEqual(allowedExitCodes);
        }
    });

    it('requires both an allowed exit code and recognizable output', () => {
        expect(() => assertMacPackagedToolSmoke('qpdf', 0, 'qpdf version 12.0.0')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('pdfinfo', 0, 'pdfinfo version 25.0.0')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('pdftoppm', 0, 'pdftoppm version 25.0.0')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('pdftotext', 0, 'pdftotext version 25.0.0')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('tesseract', 0, 'tesseract 5.5.0')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('evb-pdf-image-combine-protocol', 0, '4')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('evb-pdf-page-ops', 0, 'evb-pdf-page-ops 0.1.0')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('evb-pdf-search', 0, 'evb-pdf-search 0.1.0')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('evb-scan-cleanup', 0, 'evb-scan-cleanup 0.1.0')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('evb-scan-cleanup-protocol', 0, '3')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('evb-pdf-image-combine-compact-manifest', 1, 'Missing --compact-manifest value')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('ddjvu', 1, 'ddjvu usage')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('djvudump', 1, 'djvudump usage')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('unpaper', 0, 'Usage: unpaper [options]')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('qpdf', 2, 'qpdf version 12.0.0')).toThrow(
            'Packaged tool smoke test failed (qpdf) with exit code 2',
        );
        expect(() => assertMacPackagedToolSmoke('qpdf', 0, 'unexpected output')).toThrow(
            'Packaged tool smoke test output for qpdf did not match any expected signature',
        );
        expect(() => assertMacPackagedToolSmoke('evb-pdf-image-combine-compact-manifest', 1, 'Unknown argument: --compact-manifest')).toThrow(
            'Packaged tool smoke test output for evb-pdf-image-combine-compact-manifest did not match any expected signature',
        );
    });

    it('joins the release-target manifest to the contracts and the packaging verifier', () => {
        const verifierSource = readFileSync(resolve(process.cwd(), 'scripts/verify-packaged-native-tools.sh'), 'utf-8');
        const smokeTools = new Set(Array.from(
            verifierSource.matchAll(/run_macos_packaged_tool_smoke "([^"]+)"/gu),
            match => match[1],
        ));
        const generatedFamilies = RELEASE_TARGET_MANIFEST.families
            .filter((family): family is ReturnType<typeof getPackagedNativeToolFamilies>[number] & {binaryName: string;} => (
                family.binaryName !== null
            ));

        // The committed manifest the release scripts read is what its owner renders.
        expect(RELEASE_TARGET_MANIFEST).toEqual(createReleaseTargetManifest());
        expect(RELEASE_TARGET_MANIFEST.platformArches).toEqual(NATIVE_RESOURCE_PLATFORM_ARCHES);
        expect(RELEASE_TARGET_MANIFEST.globalResources).toEqual(GLOBAL_PACKAGED_RESOURCES);
        expect(RELEASE_TARGET_MANIFEST.schemaVersion).toBe(1);
        expect(RELEASE_TARGET_MANIFEST.signing).toEqual({
            entitlementsPathSegments: [
                'build',
                'entitlements.mac.plist',
            ],
            executableRoots: RELEASE_TARGET_MANIFEST.families.map(family => family.stagedRootSegments),
            platforms: ['darwin'],
        });
        expect(createReleaseTargetManifest().electronBuilderPlatformKeys)
            .toEqual(ELECTRON_BUILDER_PLATFORM_KEYS);

        // Its generated families are exactly the contract's Rust tools, versions included.
        expect(generatedFamilies.map(({
            binaryName,
            protocolVersion,
        }) => ({
            binaryName,
            protocolVersion,
        }))).toEqual(GENERATED_RUST_NATIVE_TOOL_PROTOCOLS.map(({
            binaryName,
            protocolVersion,
        }) => ({
            binaryName,
            protocolVersion,
        })));

        // The verifier smoke-tests every generated binary the manifest declares, so
        // deleting the hardcoded per-script target lists cannot silently drop coverage.
        for (const family of generatedFamilies) {
            expect(smokeTools.has(family.binaryName)).toBe(true);
            if (smokeTools.has(`${family.binaryName}-protocol`)) {
                expect(getMacPackagedToolSmokePolicy(`${family.binaryName}-protocol`).expectedOutputTokens)
                    .toEqual([String(family.protocolVersion)]);
            }
        }
    });

    it('leaves no release script with its own packaged-target list', () => {
        const stagedRoots = RELEASE_TARGET_MANIFEST.families.map(family => family.stagedRootSegments.join('/'));
        const allowedFamilyRootLiterals: Record<string, string[]> = {
            'scripts/afterPack.cjs': [],
            'scripts/afterSign.cjs': [],
            'scripts/generateElectronBuilderResources.ts': [],
        };

        expect(stagedRoots.length).toBeGreaterThan(1);
        for (const [
            relativePath,
            allowed,
        ] of Object.entries(allowedFamilyRootLiterals)) {
            const source = readFileSync(resolve(process.cwd(), relativePath), 'utf-8');
            const literalRoots = stagedRoots.filter(root => (
                source.includes(`'${root}'`) || source.includes(`"${root}"`)
            ));
            expect({
                consumer: relativePath,
                literalRoots,
            }).toEqual({
                consumer: relativePath,
                literalRoots: allowed,
            });
        }
        const verifierSource = readFileSync(
            resolve(process.cwd(), 'scripts/verify-packaged-native-tools.sh'),
            'utf-8',
        );
        expect(verifierSource).toContain('nativeResourceManifestCli.ts packaged-entries "$platform_arch"');
        expect(verifierSource).not.toContain('check_file "$native_tool_root/tesseract');
        expect(verifierSource).not.toContain('check_file "$native_tool_root/poppler');
    });

    it('keeps packaged OCR verification production-like and default-bundle complete', () => {
        const verifierSource = readFileSync(resolve(process.cwd(), 'scripts/verify-packaged-native-tools.sh'), 'utf-8');

        expect(verifierSource).toContain('verify_tessdata_bundle_complete "$tessdata_dir"');
        expect(verifierSource).toContain('printOcrLanguageCodes.ts --bundled');
        expect(verifierSource).toContain('get_bundled_language_codes');
        expect(verifierSource).not.toContain('DYLD_LIBRARY_PATH=');
        expect(verifierSource).not.toContain('LD_LIBRARY_PATH=');
        expect(verifierSource).toContain('windows-pe-dependencies.mjs');
        expect(verifierSource).not.toContain('objdump -p');
        expect(verifierSource).toContain('run_host_packaged_tool_smoke "tesseract" "tesseract"');
        expect(verifierSource).toContain('run_host_packaged_tool_smoke "unpaper" "unpaper|usage"');
        const tesseract = RELEASE_TARGET_MANIFEST.families.find(family => family.id === 'tesseract');
        expect(tesseract?.packagedEntries.find(entry => entry.id === 'unpaper')?.skip)
            .toEqual({win32: 'not bundled on Windows'});
    });
});
