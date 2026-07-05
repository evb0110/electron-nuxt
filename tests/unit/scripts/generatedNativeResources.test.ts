import {
    access,
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
    detectHostGeneratedNativeResourceTarget: (options?: {
        nodeArch?: string;
        nodePlatform?: string;
    }) => INativeResourceTarget;
    assertGeneratedNativeResourceFresh: (
        target: INativeResourceTarget,
        options?: INativeResourceOptions,
    ) => void;
}

interface INativeResourceTarget {
    arch: string;
    platform: string;
}

interface INativeResourceOptions {
    projectRoot?: string;
    pruneStale?: boolean;
}

const {
    GENERATED_NATIVE_TOOLS,
    detectHostGeneratedNativeResourceTarget,
    assertGeneratedNativeResourceFresh,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/check-generated-native-resources.mjs')).href
) as IGeneratedNativeResourcesModule;

async function createNativeResourceFixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'evb-native-resources-'));
    const oldDate = new Date('2026-01-01T00:00:00Z');
    const newDate = new Date('2026-01-02T00:00:00Z');

    await mkdir(path.join(root, 'native'), {recursive: true});
    await writeFile(path.join(root, 'native', 'Cargo.lock'), '# lock\n', 'utf8');

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
    it('maps supported host targets into generated resource checks', () => {
        expect(detectHostGeneratedNativeResourceTarget({
            nodeArch: 'arm64',
            nodePlatform: 'darwin',
        })).toEqual({
            arch: 'arm64',
            platform: 'mac',
        });
        expect(detectHostGeneratedNativeResourceTarget({
            nodeArch: 'x64',
            nodePlatform: 'linux',
        })).toEqual({
            arch: 'x64',
            platform: 'linux',
        });
        expect(detectHostGeneratedNativeResourceTarget({
            nodeArch: 'x64',
            nodePlatform: 'win32',
        })).toEqual({
            arch: 'x64',
            platform: 'win',
        });
    });

    it('rejects unsupported host targets', () => {
        expect(() => {
            detectHostGeneratedNativeResourceTarget({
                nodeArch: 'ia32',
                nodePlatform: 'linux',
            });
        }).toThrow('Unsupported host arch');
        expect(() => {
            detectHostGeneratedNativeResourceTarget({
                nodeArch: 'x64',
                nodePlatform: 'freebsd',
            });
        }).toThrow('Unsupported host platform');
    });

    it('fails stale staged payloads without mutating by default', async () => {
        const root = await createNativeResourceFixture();
        try {
            expect(() => {
                assertGeneratedNativeResourceFresh({
                    arch: 'x64',
                    platform: 'linux',
                }, {projectRoot: root});
            }).toThrow('Stale generated native payloads');
            await expect(access(path.join(root, '.tmp', 'pdf-image-combine', 'linux-x64'))).resolves.toBeUndefined();
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('removes stale staged payloads only in explicit prune mode', async () => {
        const root = await createNativeResourceFixture();
        try {
            expect(() => {
                assertGeneratedNativeResourceFresh({
                    arch: 'x64',
                    platform: 'linux',
                }, {
                    projectRoot: root,
                    pruneStale: true,
                });
            }).toThrow('removed stale .tmp directories');
            await expect(access(path.join(root, '.tmp', 'pdf-image-combine', 'linux-x64'))).rejects.toThrow();
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });
});
