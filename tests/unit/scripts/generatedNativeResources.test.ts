import {
    mkdir,
    mkdtemp,
    rm,
    utimes,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface IGeneratedNativeResourcesModule {
    GENERATED_NATIVE_TOOLS: Array<{
        binaryName: string;
        crateName: string;
        stagingName: string;
    }>;
    assertGeneratedNativeResourceFresh: (
        target: INativeResourceTarget,
        options?: INativeResourceOptions,
    ) => void;
}

interface INativeResourceTarget {
    arch: string;
    platform: string;
}

interface INativeResourceOptions { projectRoot?: string; }

const {
    GENERATED_NATIVE_TOOLS,
    assertGeneratedNativeResourceFresh,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/check-generated-native-resources.mjs')).href
) as IGeneratedNativeResourcesModule;

async function createNativeResourceFixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'evb-native-resources-'));
    const oldDate = new Date('2026-01-01T00:00:00Z');
    const newDate = new Date('2026-01-02T00:00:00Z');

    for (const tool of GENERATED_NATIVE_TOOLS) {
        const sourceDir = path.join(root, 'native', tool.crateName, 'src');
        const stageDir = path.join(root, '.tmp', tool.stagingName, 'linux-x64', 'bin');
        await mkdir(sourceDir, {recursive: true});
        await mkdir(stageDir, {recursive: true});
        const sourcePath = path.join(sourceDir, 'main.rs');
        const binaryPath = path.join(stageDir, tool.binaryName);
        await writeFile(path.join(root, 'native', tool.crateName, 'Cargo.toml'), '[package]\nname = "fixture"\n', 'utf8');
        await writeFile(sourcePath, 'fn main() {}\n', 'utf8');
        await writeFile(binaryPath, 'binary\n', 'utf8');
        await utimes(sourcePath, newDate, newDate);
        await utimes(binaryPath, oldDate, oldDate);
    }

    return root;
}

describe('generated native resource freshness', () => {
    it('removes stale staged payloads and fails before packaging', async () => {
        const root = await createNativeResourceFixture();
        try {
            expect(() => {
                assertGeneratedNativeResourceFresh({
                    arch: 'x64',
                    platform: 'linux',
                }, {projectRoot: root});
            }).toThrow('Stale generated native payloads');
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });
});
