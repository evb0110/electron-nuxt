import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {GENERATED_RUST_NATIVE_TOOL_PROTOCOLS} from '@contracts/nativeToolProtocols';
import {createReleaseTargetManifest} from '@scripts/generateReleaseTargetManifest';
import {
    ELECTRON_BUILDER_PLATFORM_KEYS,
    GLOBAL_PACKAGED_RESOURCES,
    type getPackagedNativeToolFamilies,
    NATIVE_RESOURCE_PLATFORM_ARCHES,
} from '@scripts/nativeResourceManifest';

const {RELEASE_TARGET_MANIFEST} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/release/native-tool-smoke-policy.mjs')).href
) as {RELEASE_TARGET_MANIFEST: {
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
}};
const nativeToolSmokePolicy = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/release/native-tool-smoke-policy.mjs')).href
) as {getMacPackagedToolSmokePolicy: (toolName: string) => {
    allowedExitCodes: ReadonlySet<number>;
    expectedOutputTokens: readonly string[];
}};

const getMacSmokePolicy = nativeToolSmokePolicy.getMacPackagedToolSmokePolicy;

function readVerifierSource() {
    return readFileSync(resolve(process.cwd(), 'scripts/verify-packaged-native-tools.sh'), 'utf8');
}

describe('native tool smoke source policy', () => {
    it('keeps mac packaged tool smoke expectations explicit per tool', () => {
        const verifierTools = Array.from(
            readVerifierSource().matchAll(/run_macos_packaged_tool_smoke "([^"]+)"/gu),
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
            expect(getMacSmokePolicy(toolName).allowedExitCodes).toEqual(allowedExitCodes);
        }
    });

    it('joins the release-target manifest to the contracts and packaging verifier', () => {
        const smokeTools = new Set(Array.from(
            readVerifierSource().matchAll(/run_macos_packaged_tool_smoke "([^"]+)"/gu),
            match => match[1],
        ));
        const generatedFamilies = RELEASE_TARGET_MANIFEST.families
            .filter((family): family is ReturnType<typeof getPackagedNativeToolFamilies>[number] & {binaryName: string} => (
                family.binaryName !== null
            ));

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

        for (const family of generatedFamilies) {
            expect(smokeTools.has(family.binaryName)).toBe(true);
            if (smokeTools.has(`${family.binaryName}-protocol`)) {
                expect(getMacSmokePolicy(`${family.binaryName}-protocol`).expectedOutputTokens)
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
            const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8');
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
        const verifierSource = readVerifierSource();
        expect(verifierSource).toContain('nativeResourceManifestCli.ts packaged-entries "$platform_arch"');
        expect(verifierSource).not.toContain('check_file "$native_tool_root/tesseract');
        expect(verifierSource).not.toContain('check_file "$native_tool_root/poppler');
    });

    it('keeps packaged OCR verification production-like and default-bundle complete', () => {
        const verifierSource = readVerifierSource();

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
