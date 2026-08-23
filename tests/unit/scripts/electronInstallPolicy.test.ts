import {writeFileSync} from 'node:fs';
import {
    mkdtemp,
    readFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {verifyElectronInstall} from '@scripts/check-electron-install.mjs';
import {createTemporaryDirectoryRegistry} from '@tests/helpers/createTemporaryDirectoryRegistry';

interface IPackageJson {scripts: Record<string, string>;}
const temporaryDirectories = createTemporaryDirectoryRegistry();

afterEach(() => temporaryDirectories.cleanup());

describe('Electron install policy', () => {
    it('runs the install check after the other root postinstall work', async () => {
        const packageJson = JSON.parse(
            await readFile('package.json', 'utf8'),
        ) as IPackageJson;

        const postinstall = packageJson.scripts.postinstall;
        if (!postinstall) {
            throw new Error('Missing postinstall script');
        }

        expect(postinstall.split(/\s*&&\s*/u)).toEqual([
            'pnpm exec nuxi prepare',
            'pnpm run copy:pdfjs',
            'pnpm run check:electron:install',
        ]);
        expect(packageJson.scripts['check:electron:install'])
            .toBe('node scripts/check-electron-install.mjs');
    });

    it('accepts a binary materialized by Electron lazy loading', async () => {
        const directory = temporaryDirectories.register(
            await mkdtemp(join(tmpdir(), 'evb-electron-install-')),
        );
        const executablePath = join(directory, 'electron');
        const loadElectron = vi.fn(() => {
            writeFileSync(executablePath, 'electron');
            return executablePath;
        });

        expect(verifyElectronInstall({loadElectron})).toBe(executablePath);
        expect(loadElectron).toHaveBeenCalledOnce();
    });

    it('rejects a lazy loader result whose executable is still missing', () => {
        expect(() => verifyElectronInstall({
            loadElectron: () => '/missing/electron',
            pathIsFile: () => false,
        })).toThrow('Electron executable does not exist at /missing/electron');
    });

    it('rejects a lazy loader result that points at a directory', async () => {
        const directory = temporaryDirectories.register(
            await mkdtemp(join(tmpdir(), 'evb-electron-install-directory-')),
        );
        const loadElectron = () => directory;

        expect(() => verifyElectronInstall({loadElectron}))
            .toThrow(`Electron executable does not exist at ${directory}`);
    });

    it('turns lazy download failures into an actionable setup error', () => {
        const loadElectron = () => {
            throw new Error('network unavailable');
        };

        expect(() => verifyElectronInstall({loadElectron})).toThrow(
            'Run pnpm install with network access, or retry this check after restoring network access. '
            + 'Original error: network unavailable',
        );
    });
});
