import {
    mkdir,
    mkdtemp,
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
import type { IGeneratedRustNativeToolProtocol } from '@contracts/nativeToolProtocols';
import { checkNativeToolProtocols } from '@scripts/checkNativeToolProtocols';

const fixtureProtocol = {
    binaryName: 'evb-fixture-tool',
    crateName: 'fixture-tool',
    protocolVersion: 7,
    resourceFamilyId: 'pdf-search',
    stagingName: 'fixture-tool',
} as const satisfies IGeneratedRustNativeToolProtocol;

async function createNativeProtocolFixture(protocol = fixtureProtocol) {
    const root = await mkdtemp(path.join(tmpdir(), 'evb-native-protocols-'));
    const crateRoot = path.join(root, 'native', protocol.crateName);

    await mkdir(path.join(crateRoot, 'src'), { recursive: true });
    await mkdir(path.join(crateRoot, 'tests'), { recursive: true });
    await writeFile(path.join(crateRoot, 'Cargo.toml'), [
        '[package]',
        `name = "${protocol.binaryName}"`,
        'version = "0.1.0"',
        'edition = "2021"',
        '',
    ].join('\n'), 'utf8');
    await writeFile(path.join(crateRoot, 'src', 'main.rs'), [
        `const PROTOCOL_VERSION: u32 = ${protocol.protocolVersion};`,
        'fn main() {}',
        '',
    ].join('\n'), 'utf8');
    await writeFile(path.join(crateRoot, 'tests', 'protocol_version.rs'), [
        'use std::process::Command;',
        '',
        '#[test]',
        'fn protocol_version_flag_prints_supported_protocol() {',
        `    let output = Command::new(env!("CARGO_BIN_EXE_${protocol.binaryName}"))`,
        '        .arg("--protocol-version")',
        '        .output()',
        '        .expect("protocol version command runs");',
        '',
        '    assert!(output.status.success());',
        `    assert_eq!(String::from_utf8(output.stdout).unwrap(), "${protocol.protocolVersion}\\n");`,
        '    assert_eq!(String::from_utf8(output.stderr).unwrap(), "");',
        '}',
        '',
    ].join('\n'), 'utf8');

    return root;
}

describe('native tool protocol checker', () => {
    it('accepts Rust source, Cargo metadata, and protocol tests that match the contract', async () => {
        const root = await createNativeProtocolFixture();
        try {
            await expect(checkNativeToolProtocols({
                projectRoot: root,
                protocols: [fixtureProtocol],
            })).resolves.toBeUndefined();
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rejects Rust protocol versions that drift from the contract', async () => {
        const root = await createNativeProtocolFixture();
        try {
            await writeFile(
                path.join(root, 'native', fixtureProtocol.crateName, 'src', 'main.rs'),
                'const PROTOCOL_VERSION: u32 = 8;\nfn main() {}\n',
                'utf8',
            );

            await expect(checkNativeToolProtocols({
                projectRoot: root,
                protocols: [fixtureProtocol],
            })).rejects.toThrow('evb-fixture-tool: native/fixture-tool/src/main.rs declares protocol 8, contract expects 7');
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });
});
