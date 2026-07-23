import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    GENERATED_RUST_NATIVE_TOOL_PROTOCOLS,
    type IGeneratedRustNativeToolProtocol,
} from '@contracts/nativeToolProtocols';
import { checkNativeToolProtocols } from '@scripts/checkNativeToolProtocols';
import {
    generateNativeToolProtocols,
    renderReleaseNativeToolProtocols,
    renderRustNativeToolProtocols,
} from '@scripts/generateNativeToolProtocols';

const fixtureProtocols = [{
    binaryName: 'evb-fixture-tool',
    crateName: 'fixture-tool',
    protocolVersion: 7,
    resourceFamilyId: 'pdf-search',
    stagingName: 'fixture-tool',
}] as const satisfies readonly IGeneratedRustNativeToolProtocol[];

describe('native tool protocol generator', () => {
    it('renders deterministic Rust and release descriptors from one registry', () => {
        const firstRust = renderRustNativeToolProtocols(fixtureProtocols);
        const firstRelease = renderReleaseNativeToolProtocols(fixtureProtocols);

        expect(renderRustNativeToolProtocols(fixtureProtocols)).toBe(firstRust);
        expect(renderReleaseNativeToolProtocols(fixtureProtocols)).toBe(firstRelease);
        expect(firstRust).toContain(
            'NativeToolDescriptor::new("evb-fixture-tool", 7);',
        );
        expect(firstRelease).toContain('protocolVersion: 7');
    });

    it('writes both artifacts and rejects drift in check mode', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'evb-native-protocols-'));
        const releasePath = path.join(root, 'scripts/release/generated-native-tool-protocols.mjs');
        const rustPath = path.join(
            root,
            'native/evb-native-support/src/generated_native_tool_protocols.rs',
        );
        try {
            await expect(generateNativeToolProtocols({
                projectRoot: root,
                protocols: fixtureProtocols,
            })).resolves.toBe(true);
            await expect(checkNativeToolProtocols({
                projectRoot: root,
                protocols: fixtureProtocols,
            })).resolves.toBeUndefined();
            expect(await readFile(rustPath, 'utf8')).toBe(
                renderRustNativeToolProtocols(fixtureProtocols),
            );
            expect(await readFile(releasePath, 'utf8')).toBe(
                renderReleaseNativeToolProtocols(fixtureProtocols),
            );

            await writeFile(releasePath, '// stale\n', 'utf8');
            await expect(checkNativeToolProtocols({
                projectRoot: root,
                protocols: fixtureProtocols,
            })).rejects.toThrow('scripts/release/generated-native-tool-protocols.mjs is stale');
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('pins the canonical protocol versions during generation', () => {
        expect(GENERATED_RUST_NATIVE_TOOL_PROTOCOLS.map(protocol => [
            protocol.binaryName,
            protocol.protocolVersion,
        ])).toEqual([
            [
                'evb-pdf-image-combine',
                3,
            ],
            [
                'evb-pdf-page-ops',
                1,
            ],
            [
                'evb-pdf-search',
                1,
            ],
            [
                'evb-scan-cleanup',
                2,
            ],
        ]);
    });
});
