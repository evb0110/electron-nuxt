import {
    existsSync,
    readFileSync,
} from 'node:fs';
import {
    join,
    resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface IWindowsPeDependenciesModule {
    normalizeWindowsHostPath: (filePath: string, platform?: NodeJS.Platform) => string;
    readWindowsPeInfo: (filePath: string) => {
        imports: string[];
        machine: string;
        machineCode: number;
    };
}

const projectRoot = process.cwd();
const popplerBin = resolve(projectRoot, 'resources/poppler/win32-x64/bin');
const bundlerSource = readFileSync(resolve(projectRoot, 'scripts/bundle-tools-windows.sh'), 'utf8');
const {readWindowsPeInfo} = await import(pathToFileURL(resolve(
    projectRoot,
    'scripts/release/windows-pe-dependencies.mjs',
)).href) as IWindowsPeDependenciesModule;

describe('Windows Poppler bundle policy', () => {
    it('does not retain the unused optional GLib binding', () => {
        expect(bundlerSource).toContain('rm -f "$POPPLER_DIR/bin/poppler-glib.dll"');
        expect(existsSync(join(popplerBin, 'poppler-glib.dll'))).toBe(false);
    });

    it.each([
        'pdfimages.exe',
        'pdfinfo.exe',
        'pdftocairo.exe',
        'pdftoppm.exe',
        'pdftotext.exe',
    ])('%s does not import the optional GLib binding', (executable) => {
        const imports = readWindowsPeInfo(join(popplerBin, executable)).imports
            .map(dependency => dependency.toLowerCase());

        expect(imports).not.toContain('poppler-glib.dll');
    });
});
