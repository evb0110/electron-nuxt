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
import {
    generateNativeToolProtocols,
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
    it('renders deterministic Rust descriptors from one registry', () => {
        const firstRust = renderRustNativeToolProtocols(fixtureProtocols);

        expect(renderRustNativeToolProtocols(fixtureProtocols)).toBe(firstRust);
        expect(firstRust).toContain(
            'NativeToolDescriptor::new("evb-fixture-tool", 7);',
        );
    });

    it('writes the Rust artifact byte-stably and repairs generated drift', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'evb-native-protocols-'));
        const rustPath = path.join(
            root,
            'native/evb-native-support/src/generated_native_tool_protocols.rs',
        );
        try {
            await expect(generateNativeToolProtocols({
                projectRoot: root,
                protocols: fixtureProtocols,
            })).resolves.toBe(true);
            await expect(generateNativeToolProtocols({
                projectRoot: root,
                protocols: fixtureProtocols,
            })).resolves.toBe(false);
            expect(await readFile(rustPath, 'utf8')).toBe(
                renderRustNativeToolProtocols(fixtureProtocols),
            );

            await writeFile(rustPath, '// stale\n', 'utf8');
            await expect(generateNativeToolProtocols({
                projectRoot: root,
                protocols: fixtureProtocols,
            })).resolves.toBe(true);
            expect(await readFile(rustPath, 'utf8')).toBe(
                renderRustNativeToolProtocols(fixtureProtocols),
            );
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
                4,
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
                6,
            ],
        ]);
    });
});
