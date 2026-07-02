import { createRequire } from 'node:module';
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

type TRequiredExtraResourceType = 'directory' | 'file';

interface IAfterPackContext {
    appOutDir: string;
    arch: number | string;
    electronPlatformName: string;
    packager: {
        appInfo: { productFilename: string };
        getResourcesDir: (appOutDir: string) => string;
    };
}

interface IRequiredExtraResource {
    label: string;
    sourcePath: string;
    stagedPath: string;
    tag: string;
    type: TRequiredExtraResourceType;
}

interface IAfterPackModule {
    assertRequiredExtraResources: (context: IAfterPackContext, options?: {
        projectRoot?: string;
        resourcesDir?: string;
    }) => void;
    requiredExtraResourcesForContext: (context: IAfterPackContext, options?: {
        projectRoot?: string;
        resourcesDir?: string;
    }) => IRequiredExtraResource[];
}

const requireScript = createRequire(import.meta.url);
const {
    assertRequiredExtraResources,
    requiredExtraResourcesForContext,
} = requireScript(path.join(process.cwd(), 'scripts/afterPack.cjs')) as IAfterPackModule;

function createContext(platform: string, arch: string, resourcesDir: string): IAfterPackContext {
    return {
        appOutDir: path.dirname(resourcesDir),
        arch,
        electronPlatformName: platform,
        packager: {
            appInfo: { productFilename: 'EVB Viewer' },
            getResourcesDir: () => resourcesDir,
        },
    };
}

async function createRequiredPath(filePath: string, type: TRequiredExtraResourceType) {
    if (type === 'file') {
        await mkdir(path.dirname(filePath), {recursive: true});
        await writeFile(filePath, 'fixture', 'utf8');
        return;
    }

    await mkdir(filePath, {recursive: true});
}

async function createRequiredPaths(entries: IRequiredExtraResource[], side: 'source' | 'staged') {
    await Promise.all(entries.map(entry => createRequiredPath(
        side === 'source' ? entry.sourcePath : entry.stagedPath,
        entry.type,
    )));
}

function captureErrorMessage(action: () => void) {
    try {
        action();
    } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
    }

    throw new Error('Expected action to throw');
}

describe('afterPack extraResources preflight', () => {
    it('maps every required platform extraResource for the target tag', () => {
        const entries = requiredExtraResourcesForContext(
            createContext('darwin', 'arm64', '/app/EVB Viewer.app/Contents/Resources'),
            {projectRoot: '/repo'},
        );

        expect(entries).toEqual([
            expect.objectContaining({
                label: 'tessdata directory',
                sourcePath: path.join('/repo', 'resources', 'tesseract', 'tessdata'),
                stagedPath: path.join('/app/EVB Viewer.app/Contents/Resources', 'tesseract', 'tessdata'),
                tag: 'darwin-arm64',
                type: 'directory',
            }),
            expect.objectContaining({
                label: 'application resource icon',
                sourcePath: path.join('/repo', 'resources', 'icon.png'),
                stagedPath: path.join('/app/EVB Viewer.app/Contents/Resources', 'icon.png'),
                tag: 'darwin-arm64',
                type: 'file',
            }),
            expect.objectContaining({
                label: 'Tesseract native tools (darwin-arm64)',
                sourcePath: path.join('/repo', 'resources', 'tesseract', 'darwin-arm64'),
                stagedPath: path.join('/app/EVB Viewer.app/Contents/Resources', 'tesseract', 'darwin-arm64'),
                tag: 'darwin-arm64',
                type: 'directory',
            }),
            expect.objectContaining({
                label: 'Poppler native tools (darwin-arm64)',
                sourcePath: path.join('/repo', 'resources', 'poppler', 'darwin-arm64'),
                stagedPath: path.join('/app/EVB Viewer.app/Contents/Resources', 'poppler', 'darwin-arm64'),
                tag: 'darwin-arm64',
                type: 'directory',
            }),
            expect.objectContaining({
                label: 'qpdf native tools (darwin-arm64)',
                sourcePath: path.join('/repo', 'resources', 'qpdf', 'darwin-arm64'),
                stagedPath: path.join('/app/EVB Viewer.app/Contents/Resources', 'qpdf', 'darwin-arm64'),
                tag: 'darwin-arm64',
                type: 'directory',
            }),
            expect.objectContaining({
                label: 'DjVuLibre native tools (darwin-arm64)',
                sourcePath: path.join('/repo', 'resources', 'djvulibre', 'darwin-arm64'),
                stagedPath: path.join('/app/EVB Viewer.app/Contents/Resources', 'djvulibre', 'darwin-arm64'),
                tag: 'darwin-arm64',
                type: 'directory',
            }),
            expect.objectContaining({
                label: 'PDF image combine native tool (darwin-arm64)',
                sourcePath: path.join('/repo', '.tmp', 'pdf-image-combine', 'darwin-arm64'),
                stagedPath: path.join('/app/EVB Viewer.app/Contents/Resources', 'pdf-image-combine', 'darwin-arm64'),
                tag: 'darwin-arm64',
                type: 'directory',
            }),
            expect.objectContaining({
                label: 'PDF page ops native tool (darwin-arm64)',
                sourcePath: path.join('/repo', '.tmp', 'pdf-page-ops', 'darwin-arm64'),
                stagedPath: path.join('/app/EVB Viewer.app/Contents/Resources', 'pdf-page-ops', 'darwin-arm64'),
                tag: 'darwin-arm64',
                type: 'directory',
            }),
            expect.objectContaining({
                label: 'PDF search native tool (darwin-arm64)',
                sourcePath: path.join('/repo', '.tmp', 'pdf-search', 'darwin-arm64'),
                stagedPath: path.join('/app/EVB Viewer.app/Contents/Resources', 'pdf-search', 'darwin-arm64'),
                tag: 'darwin-arm64',
                type: 'directory',
            }),
        ]);
        expect(entries.map(entry => entry.sourcePath).join('\n')).not.toContain('page-processing');
    });

    it('fails with useful source-path messages when required extraResources are absent', async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-after-pack-extra-resources-'));
        const resourcesDir = path.join(tempRoot, 'app-out', 'resources');
        const context = createContext('linux', 'x64', resourcesDir);

        try {
            const message = captureErrorMessage(() => assertRequiredExtraResources(context, {projectRoot: tempRoot}));

            expect(message).toContain('[afterPack] Missing required electron-builder extraResources for linux-x64:');
            expect(message).toContain(path.join(tempRoot, 'resources', 'tesseract', 'tessdata'));
            expect(message).toContain(path.join(tempRoot, '.tmp', 'pdf-search', 'linux-x64'));
            expect(message).not.toContain('page-processing');
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('also fails when electron-builder did not stage a required source', async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-after-pack-extra-resources-'));
        const resourcesDir = path.join(tempRoot, 'app-out', 'resources');
        const context = createContext('win32', 'arm64', resourcesDir);
        const entries = requiredExtraResourcesForContext(context, {projectRoot: tempRoot});

        try {
            await createRequiredPaths(entries, 'source');

            const message = captureErrorMessage(() => assertRequiredExtraResources(context, {projectRoot: tempRoot}));

            expect(message).toContain(`packaged PDF search native tool (win32-arm64): ${path.join(resourcesDir, 'pdf-search', 'win32-arm64')}`);

            await createRequiredPaths(entries, 'staged');

            expect(() => assertRequiredExtraResources(context, {projectRoot: tempRoot})).not.toThrow();
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});
