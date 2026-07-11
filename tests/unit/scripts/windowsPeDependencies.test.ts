import {
    copyFileSync,
    mkdtempSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
    dirname,
    join,
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
    verifyWindowsPeDependencies: (options: {
        allowedMachines: string[];
        files: string[];
        systemDllPattern: RegExp;
    }) => string[];
}

const {
    normalizeWindowsHostPath,
    readWindowsPeInfo,
    verifyWindowsPeDependencies,
} = await import(pathToFileURL(join(process.cwd(), 'scripts/release/windows-pe-dependencies.mjs')).href) as IWindowsPeDependenciesModule;

const machineCodes = {
    arm64: 0xaa64,
    ia32: 0x014c,
    x64: 0x8664,
};

function createPeFixture(machine: keyof typeof machineCodes, imports: string[]) {
    const buffer = Buffer.alloc(4096);
    const peOffset = 0x80;
    const optionalHeaderOffset = peOffset + 24;
    const sectionHeaderOffset = optionalHeaderOffset + 0xf0;
    const sectionRawOffset = 0x200;
    const sectionVirtualAddress = 0x1000;
    const importDirectoryRva = imports.length > 0 ? sectionVirtualAddress : 0;
    const importDirectorySize = imports.length > 0 ? (imports.length + 1) * 20 : 0;

    buffer.write('MZ', 0, 'ascii');
    buffer.writeUInt32LE(peOffset, 0x3c);
    buffer.write('PE\u0000\u0000', peOffset, 'ascii');
    buffer.writeUInt16LE(machineCodes[machine], peOffset + 4);
    buffer.writeUInt16LE(1, peOffset + 6);
    buffer.writeUInt16LE(0xf0, peOffset + 20);

    buffer.writeUInt16LE(0x20b, optionalHeaderOffset);
    buffer.writeUInt32LE(0x200, optionalHeaderOffset + 60);
    buffer.writeUInt32LE(16, optionalHeaderOffset + 108);
    buffer.writeUInt32LE(importDirectoryRva, optionalHeaderOffset + 120);
    buffer.writeUInt32LE(importDirectorySize, optionalHeaderOffset + 124);

    buffer.write('.rdata\u0000\u0000', sectionHeaderOffset, 'ascii');
    buffer.writeUInt32LE(0x1000, sectionHeaderOffset + 8);
    buffer.writeUInt32LE(sectionVirtualAddress, sectionHeaderOffset + 12);
    buffer.writeUInt32LE(0x1000, sectionHeaderOffset + 16);
    buffer.writeUInt32LE(sectionRawOffset, sectionHeaderOffset + 20);

    let nameOffset = sectionRawOffset + 0x100;
    for (const [
        index,
        importName,
    ] of imports.entries()) {
        const descriptorOffset = sectionRawOffset + index * 20;
        const nameRva = sectionVirtualAddress + (nameOffset - sectionRawOffset);
        buffer.writeUInt32LE(nameRva, descriptorOffset + 12);
        buffer.writeUInt32LE(0x2000 + index * 8, descriptorOffset + 16);
        buffer.write(`${importName}\u0000`, nameOffset, 'ascii');
        nameOffset += importName.length + 1;
    }

    const fixturePath = join(mkdtempSync(join(tmpdir(), 'evb-pe-fixture-')), `${machine}.dll`);
    writeFileSync(fixturePath, buffer);
    return fixturePath;
}

describe('Windows PE dependency helpers', () => {
    it('normalizes MSYS drive paths before Windows Node filesystem access', () => {
        expect(normalizeWindowsHostPath('/d/a/evb-viewer/resources/qpdf.exe', 'win32'))
            .toBe('D:/a/evb-viewer/resources/qpdf.exe');
        expect(normalizeWindowsHostPath('D:\\a\\evb-viewer\\resources\\qpdf.exe', 'win32'))
            .toBe('D:\\a\\evb-viewer\\resources\\qpdf.exe');
        expect(normalizeWindowsHostPath('/d/a/evb-viewer/resources/qpdf.exe', 'darwin'))
            .toBe('/d/a/evb-viewer/resources/qpdf.exe');
    });

    it('reads ARM64 PE machine type and import DLL names without objdump', () => {
        const filePath = createPeFixture('arm64', [
            'KERNEL32.dll',
            'glib-2.0-0.dll',
        ]);

        expect(readWindowsPeInfo(filePath)).toMatchObject({
            machine: 'arm64',
            imports: [
                'KERNEL32.dll',
                'glib-2.0-0.dll',
            ],
        });
    });

    it('validates bundled dependencies, system DLLs, and lib-prefixed aliases', () => {
        const toolPath = createPeFixture('arm64', [
            'KERNEL32.dll',
            'glib-2.0-0.dll',
        ]);
        const bundledAliasPath = join(dirname(toolPath), 'libglib-2.0-0.dll');
        copyFileSync(createPeFixture('arm64', []), bundledAliasPath);

        expect(verifyWindowsPeDependencies({
            allowedMachines: ['arm64'],
            files: [
                toolPath,
                bundledAliasPath,
            ],
            systemDllPattern: /^(kernel32\.dll)$/iu,
        })).toEqual([]);
    });

    it('does not satisfy an import with a DLL bundled beside another tool', () => {
        const toolPath = createPeFixture('arm64', ['custom-runtime.dll']);
        const siblingToolDirectory = mkdtempSync(join(tmpdir(), 'evb-pe-other-tool-'));
        const misplacedDllPath = join(siblingToolDirectory, 'custom-runtime.dll');
        copyFileSync(createPeFixture('arm64', []), misplacedDllPath);

        expect(verifyWindowsPeDependencies({
            allowedMachines: ['arm64'],
            files: [
                toolPath,
                misplacedDllPath,
            ],
            systemDllPattern: /^kernel32\.dll$/iu,
        })).toEqual([expect.stringContaining('Missing bundled DLL dependency "custom-runtime.dll"')]);
    });

    it('allows mixed ia32 and x64 PE files in Windows x64 packages', () => {
        expect(verifyWindowsPeDependencies({
            allowedMachines: [
                'ia32',
                'x64',
            ],
            files: [
                createPeFixture('ia32', []),
                createPeFixture('x64', []),
            ],
            systemDllPattern: /^kernel32\.dll$/iu,
        })).toEqual([]);
    });

    it('rejects orphan MSYS2 training DLLs with unbundled runtime dependencies', () => {
        const trainingDllPath = createPeFixture('arm64', [
            'libpango-1.0-0.dll',
            'libpangocairo-1.0-0.dll',
        ]);

        expect(verifyWindowsPeDependencies({
            allowedMachines: ['arm64'],
            files: [trainingDllPath],
            systemDllPattern: /^kernel32\.dll$/iu,
        })).toEqual([
            expect.stringContaining('Missing bundled DLL dependency "libpango-1.0-0.dll"'),
            expect.stringContaining('Missing bundled DLL dependency "libpangocairo-1.0-0.dll"'),
        ]);
    });

    it('reports missing bundled DLLs and architecture mismatches', () => {
        const toolPath = createPeFixture('x64', ['custom-runtime.dll']);

        expect(verifyWindowsPeDependencies({
            allowedMachines: ['arm64'],
            files: [toolPath],
            systemDllPattern: /^kernel32\.dll$/iu,
        })).toEqual([
            expect.stringContaining('expected one of arm64, got x64'),
            expect.stringContaining('Missing bundled DLL dependency "custom-runtime.dll"'),
        ]);
    });
});
