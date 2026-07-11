#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const MACHINE_NAMES = new Map([
    [
        0x014c,
        'ia32',
    ],
    [
        0x8664,
        'x64',
    ],
    [
        0xaa64,
        'arm64',
    ],
]);

export function normalizeWindowsHostPath(filePath, platform = process.platform) {
    if (platform !== 'win32') {
        return filePath;
    }

    const msysDrivePath = /^\/([a-z])(?:\/(.*))?$/iu.exec(filePath);
    if (!msysDrivePath) {
        return filePath;
    }

    const [
        ,
        drive,
        remainder = '',
    ] = msysDrivePath;
    return `${drive.toUpperCase()}:/${remainder}`;
}

function fail(message) {
    throw new Error(message);
}

function ensureRange(buffer, offset, length, label) {
    if (offset < 0 || length < 0 || offset + length > buffer.length) {
        fail(`${label} is outside the file bounds`);
    }
}

function readUInt16(buffer, offset, label) {
    ensureRange(buffer, offset, 2, label);
    return buffer.readUInt16LE(offset);
}

function readUInt32(buffer, offset, label) {
    ensureRange(buffer, offset, 4, label);
    return buffer.readUInt32LE(offset);
}

function readCString(buffer, offset, label) {
    ensureRange(buffer, offset, 1, label);
    let end = offset;
    while (end < buffer.length && buffer[end] !== 0) {
        end += 1;
    }
    if (end >= buffer.length) {
        fail(`${label} is not null-terminated`);
    }

    return buffer.toString('ascii', offset, end);
}

function rvaToOffset(rva, sections, sizeOfHeaders) {
    if (rva < sizeOfHeaders) {
        return rva;
    }

    for (const section of sections) {
        const mappedSize = Math.max(section.virtualSize, section.sizeOfRawData);
        if (rva >= section.virtualAddress && rva < section.virtualAddress + mappedSize) {
            return section.pointerToRawData + (rva - section.virtualAddress);
        }
    }

    fail(`Unable to map PE RVA 0x${rva.toString(16)} to a file offset`);
}

export function readWindowsPeInfo(filePath) {
    const buffer = readFileSync(normalizeWindowsHostPath(filePath));

    if (buffer.length < 0x40 || buffer.toString('ascii', 0, 2) !== 'MZ') {
        fail('Missing DOS MZ header');
    }

    const peOffset = readUInt32(buffer, 0x3c, 'PE header pointer');
    ensureRange(buffer, peOffset, 24, 'PE header');
    if (buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\u0000\u0000') {
        fail('Missing PE signature');
    }

    const coffOffset = peOffset + 4;
    const machineCode = readUInt16(buffer, coffOffset, 'COFF machine');
    const numberOfSections = readUInt16(buffer, coffOffset + 2, 'COFF section count');
    const sizeOfOptionalHeader = readUInt16(buffer, coffOffset + 16, 'COFF optional header size');
    const optionalHeaderOffset = coffOffset + 20;
    ensureRange(buffer, optionalHeaderOffset, sizeOfOptionalHeader, 'optional header');

    const optionalMagic = readUInt16(buffer, optionalHeaderOffset, 'optional header magic');
    const dataDirectoryOffset = optionalMagic === 0x10b
        ? optionalHeaderOffset + 96
        : optionalMagic === 0x20b
            ? optionalHeaderOffset + 112
            : fail(`Unsupported PE optional header magic 0x${optionalMagic.toString(16)}`);
    const numberOfRvaAndSizesOffset = dataDirectoryOffset - 4;
    const numberOfRvaAndSizes = readUInt32(buffer, numberOfRvaAndSizesOffset, 'data directory count');
    const sizeOfHeaders = readUInt32(buffer, optionalHeaderOffset + 60, 'PE headers size');

    const sectionHeaderOffset = optionalHeaderOffset + sizeOfOptionalHeader;
    const sections = [];
    for (let sectionIndex = 0; sectionIndex < numberOfSections; sectionIndex += 1) {
        const offset = sectionHeaderOffset + sectionIndex * 40;
        ensureRange(buffer, offset, 40, `section header ${sectionIndex}`);
        sections.push({
            virtualSize: readUInt32(buffer, offset + 8, `section ${sectionIndex} virtual size`),
            virtualAddress: readUInt32(buffer, offset + 12, `section ${sectionIndex} virtual address`),
            sizeOfRawData: readUInt32(buffer, offset + 16, `section ${sectionIndex} raw size`),
            pointerToRawData: readUInt32(buffer, offset + 20, `section ${sectionIndex} raw pointer`),
        });
    }

    const imports = [];
    if (numberOfRvaAndSizes > 1) {
        const importDirectoryEntryOffset = dataDirectoryOffset + 8;
        const importDirectoryRva = readUInt32(buffer, importDirectoryEntryOffset, 'import directory RVA');
        const importDirectorySize = readUInt32(buffer, importDirectoryEntryOffset + 4, 'import directory size');

        if (importDirectoryRva !== 0) {
            const importDirectoryOffset = rvaToOffset(importDirectoryRva, sections, sizeOfHeaders);
            const maxDescriptors = importDirectorySize > 0 ? Math.ceil(importDirectorySize / 20) : 4096;
            for (let descriptorIndex = 0; descriptorIndex < maxDescriptors; descriptorIndex += 1) {
                const descriptorOffset = importDirectoryOffset + descriptorIndex * 20;
                const originalFirstThunk = readUInt32(buffer, descriptorOffset, `import descriptor ${descriptorIndex} original thunk`);
                const nameRva = readUInt32(buffer, descriptorOffset + 12, `import descriptor ${descriptorIndex} name RVA`);
                const firstThunk = readUInt32(buffer, descriptorOffset + 16, `import descriptor ${descriptorIndex} first thunk`);

                if (originalFirstThunk === 0 && nameRva === 0 && firstThunk === 0) {
                    break;
                }
                if (nameRva === 0) {
                    fail(`Import descriptor ${descriptorIndex} has no DLL name RVA`);
                }

                imports.push(readCString(buffer, rvaToOffset(nameRva, sections, sizeOfHeaders), `import descriptor ${descriptorIndex} DLL name`));
            }
        }
    }

    return {
        machine: MACHINE_NAMES.get(machineCode) ?? `unknown-0x${machineCode.toString(16)}`,
        machineCode,
        imports,
    };
}

function readSystemDllPattern(patternFilePath) {
    const source = readFileSync(patternFilePath, 'utf8');
    const match = /^system_dll_pattern='([^']+)'/mu.exec(source);
    if (!match?.[1]) {
        fail(`Unable to read system_dll_pattern from ${patternFilePath}`);
    }

    return new RegExp(match[1], 'iu');
}

export function verifyWindowsPeDependencies({
    allowedMachines,
    files,
    systemDllPattern,
}) {
    files = files.map(file => normalizeWindowsHostPath(file));
    const allowedMachineSet = new Set(allowedMachines);
    const bundledDllsByDirectory = new Map();
    for (const file of files.filter(file => /\.dll$/iu.test(file))) {
        const directory = path.resolve(path.dirname(file));
        const names = bundledDllsByDirectory.get(directory) ?? new Set();
        names.add(path.basename(file).toLowerCase());
        bundledDllsByDirectory.set(directory, names);
    }
    const errors = [];

    if (files.length === 0) {
        return ['Error: No Windows PE files were found for dependency verification'];
    }

    for (const file of files) {
        let info;
        try {
            info = readWindowsPeInfo(file);
        } catch (error) {
            errors.push(`Error: Unable to read Windows PE headers for ${file}\n  ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }

        if (!allowedMachineSet.has(info.machine)) {
            errors.push(`Error: Architecture mismatch for ${file}: expected one of ${allowedMachines.join(', ')}, got ${info.machine}`);
        }

        for (const dependency of info.imports) {
            const dependencyName = dependency.toLowerCase();
            const localBundledDlls = bundledDllsByDirectory.get(path.resolve(path.dirname(file))) ?? new Set();
            if (systemDllPattern.test(dependencyName)) {
                continue;
            }
            if (!localBundledDlls.has(dependencyName) && !localBundledDlls.has(`lib${dependencyName}`)) {
                errors.push(`Error: Missing bundled DLL dependency "${dependency}" for ${file}`);
            }
        }
    }

    return errors;
}

function usage() {
    return [
        'Usage:',
        '  node scripts/release/windows-pe-dependencies.mjs info <file>',
        '  node scripts/release/windows-pe-dependencies.mjs imports <file>',
        '  node scripts/release/windows-pe-dependencies.mjs verify --allowed-machines <ia32,x64|arm64> --system-dll-pattern-file <path> --file-list <path>',
    ].join('\n');
}

function readFileList(fileListPath) {
    return readFileSync(fileListPath, 'utf8')
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(Boolean);
}

function parseVerifyArgs(args) {
    const options = {
        allowedMachines: [],
        fileListPath: '',
        systemDllPatternFile: '',
    };

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        const value = args[index + 1];
        if (arg === '--allowed-machines' && value) {
            options.allowedMachines = value.split(',')
                .map(machine => machine.trim())
                .filter(Boolean);
            index += 1;
        } else if (arg === '--system-dll-pattern-file' && value) {
            options.systemDllPatternFile = value;
            index += 1;
        } else if (arg === '--file-list' && value) {
            options.fileListPath = value;
            index += 1;
        } else {
            fail(`Unknown or incomplete option: ${arg}`);
        }
    }

    if (options.allowedMachines.length === 0 || !options.systemDllPatternFile || !options.fileListPath) {
        fail('Missing required verify options');
    }

    return options;
}

function runCli() {
    const [
        command,
        ...args
    ] = process.argv.slice(2);

    if (command === 'info' || command === 'imports') {
        const filePath = args[0];
        if (!filePath) {
            fail(usage());
        }

        const info = readWindowsPeInfo(filePath);
        if (command === 'imports') {
            process.stdout.write(`${info.imports.join('\n')}${info.imports.length > 0 ? '\n' : ''}`);
        } else {
            process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
        }
        return;
    }

    if (command === 'verify') {
        const options = parseVerifyArgs(args);
        const errors = verifyWindowsPeDependencies({
            allowedMachines: options.allowedMachines,
            files: readFileList(options.fileListPath),
            systemDllPattern: readSystemDllPattern(options.systemDllPatternFile),
        });
        if (errors.length > 0) {
            process.stderr.write(`${errors.join('\n')}\n`);
            process.exitCode = 1;
        }
        return;
    }

    fail(usage());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        runCli();
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
