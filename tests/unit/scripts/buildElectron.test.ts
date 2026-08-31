import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {WORKER_BUNDLES} from '@electron-worker-bundles/electronWorkerBundles.js';

const mocks = vi.hoisted(() => ({
    build: vi.fn(),
    copyFile: vi.fn(),
    execFileSync: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
    writeFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
    copyFile: mocks.copyFile,
    mkdir: mocks.mkdir,
    rm: mocks.rm,
    writeFile: mocks.writeFile,
}));

vi.mock('node:child_process', () => ({execFileSync: mocks.execFileSync}));

vi.mock('esbuild', () => ({default: {build: mocks.build}}));

describe('Electron build script', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('builds the main, preload, and registered utility bundles', async () => {
        vi.stubEnv('EVB_ELECTRON_SOURCEMAP', '1');
        mocks.build.mockResolvedValue({metafile: {outputs: {}}});
        mocks.copyFile.mockResolvedValue(undefined);
        mocks.mkdir.mockResolvedValue(undefined);
        mocks.rm.mockResolvedValue(undefined);
        mocks.writeFile.mockResolvedValue(undefined);
        mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
            if (command === 'git' && args[0] === 'rev-parse') {
                return 'a'.repeat(40);
            }
            return '';
        });

        await import('@scripts/build-electron.mjs');

        expect(mocks.rm).toHaveBeenCalledWith('dist-electron', {
            force: true,
            recursive: true,
        });
        expect(mocks.mkdir).toHaveBeenCalledWith('dist-electron', {recursive: true});
        expect(mocks.build).toHaveBeenCalledTimes(2 + WORKER_BUNDLES.length);
        expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({
            bundle: true,
            entryPoints: {main: 'electron/main.ts'},
            metafile: true,
            outdir: 'dist-electron',
            sourcemap: 'external',
        }));
        expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({
            bundle: true,
            entryPoints: ['electron/preload.ts'],
            metafile: true,
            outfile: 'dist-electron/preload.cjs',
            sourcemap: 'external',
        }));
        expect(mocks.copyFile).toHaveBeenCalledWith(
            'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
            'dist-electron/pdf.worker.mjs',
        );
        expect(mocks.writeFile).toHaveBeenCalledWith(
            'dist-electron/package.json',
            `${JSON.stringify({type: 'module'}, null, 4)}\n`,
        );
    });
});
