import {
    access,
    readdir,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    GENERATED_RUST_NATIVE_TOOL_PROTOCOLS,
    type IGeneratedRustNativeToolProtocol,
} from '@contracts/nativeToolProtocols';

export interface ICheckNativeToolProtocolsOptions {
    projectRoot?: string;
    protocols?: readonly IGeneratedRustNativeToolProtocol[];
}

interface IProtocolVersionDeclaration {
    filePath: string;
    version: number;
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const protocolVersionPattern = /\bPROTOCOL_VERSION\s*:\s*u32\s*=\s*(\d+)\s*;/gu;
const sectionHeadingPattern = /^\s*\[\[?[^\]]+\]\]?\s*$/mu;

export async function checkNativeToolProtocols(options: ICheckNativeToolProtocolsOptions = {}) {
    const root = options.projectRoot ?? projectRoot;
    const protocols = options.protocols ?? GENERATED_RUST_NATIVE_TOOL_PROTOCOLS;
    const errors: string[] = [];

    for (const protocol of protocols) {
        errors.push(...await checkNativeToolProtocol(root, protocol));
    }

    if (errors.length > 0) {
        throw new Error([
            'Native tool protocol contract drift detected:',
            ...errors.map(error => `- ${error}`),
        ].join('\n'));
    }
}

async function checkNativeToolProtocol(root: string, protocol: IGeneratedRustNativeToolProtocol) {
    const errors: string[] = [];
    const crateRoot = path.join(root, 'native', protocol.crateName);
    const srcRoot = path.join(crateRoot, 'src');
    const cargoTomlPath = path.join(crateRoot, 'Cargo.toml');
    const protocolTestPath = path.join(crateRoot, 'tests', 'protocol_version.rs');

    try {
        await access(crateRoot);
    } catch {
        return [`${protocol.binaryName}: missing native crate at ${path.relative(root, crateRoot)}`];
    }

    errors.push(...await checkCargoMetadata(root, crateRoot, cargoTomlPath, protocol));
    errors.push(...await checkProtocolVersionDeclarations(root, srcRoot, protocol));
    errors.push(...await checkProtocolVersionTest(root, protocolTestPath, protocol));

    return errors;
}

async function checkCargoMetadata(
    root: string,
    crateRoot: string,
    cargoTomlPath: string,
    protocol: IGeneratedRustNativeToolProtocol,
) {
    const errors: string[] = [];
    const cargoToml = await readText(cargoTomlPath, `${protocol.binaryName}: missing Cargo.toml`);
    if (cargoToml === null) {
        return errors;
    }

    const packageName = getTomlSectionString(cargoToml, 'package', 'name');
    const explicitBinaryNames = getTomlArraySectionStrings(cargoToml, 'bin', 'name');
    const hasDefaultMain = await pathExists(path.join(crateRoot, 'src', 'main.rs'));
    const hasBinaryMapping = explicitBinaryNames.includes(protocol.binaryName)
        || (packageName === protocol.binaryName && hasDefaultMain);

    if (packageName !== protocol.binaryName && explicitBinaryNames.length === 0) {
        errors.push(`${protocol.binaryName}: Cargo package name ${formatOptionalString(packageName)} does not match contract binaryName and no [[bin]] name is declared`);
    } else if (!hasBinaryMapping) {
        errors.push(`${protocol.binaryName}: Cargo metadata does not declare a binary named ${protocol.binaryName}`);
    }

    if (!hasDefaultMain && explicitBinaryNames.length === 0) {
        errors.push(`${protocol.binaryName}: Cargo binary mapping has no ${path.relative(root, path.join(crateRoot, 'src', 'main.rs'))} and no [[bin]] override`);
    }

    return errors;
}

async function checkProtocolVersionDeclarations(
    root: string,
    srcRoot: string,
    protocol: IGeneratedRustNativeToolProtocol,
) {
    const declarations = await collectProtocolVersionDeclarations(srcRoot);
    if (declarations.length !== 1) {
        return [`${protocol.binaryName}: expected exactly one PROTOCOL_VERSION: u32 declaration under ${path.relative(root, srcRoot)}, found ${declarations.length}`];
    }

    const declaration = declarations[0];
    if (declaration === undefined || declaration.version !== protocol.protocolVersion) {
        return [`${protocol.binaryName}: ${path.relative(root, declaration?.filePath ?? srcRoot)} declares protocol ${declaration?.version ?? '<missing>'}, contract expects ${protocol.protocolVersion}`];
    }

    return [];
}

async function checkProtocolVersionTest(
    root: string,
    protocolTestPath: string,
    protocol: IGeneratedRustNativeToolProtocol,
) {
    const testSource = await readText(protocolTestPath, `${protocol.binaryName}: missing tests/protocol_version.rs`);
    if (testSource === null) {
        return [];
    }

    const errors: string[] = [];
    if (!testSource.includes(`CARGO_BIN_EXE_${protocol.binaryName}`)) {
        errors.push(`${protocol.binaryName}: protocol_version.rs does not invoke CARGO_BIN_EXE_${protocol.binaryName}`);
    }

    const expectedStdout = `"${protocol.protocolVersion}\\n"`;
    if (!testSource.includes(expectedStdout)) {
        errors.push(`${protocol.binaryName}: protocol_version.rs does not assert stdout ${expectedStdout} in ${path.relative(root, protocolTestPath)}`);
    }

    return errors;
}

async function collectProtocolVersionDeclarations(srcRoot: string) {
    const declarations: IProtocolVersionDeclaration[] = [];

    async function visit(directory: string) {
        const entries = await readdir(directory, { withFileTypes: true });
        await Promise.all(entries.map(async (entry) => {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await visit(entryPath);
                return;
            }
            if (!entry.isFile() || !entry.name.endsWith('.rs')) {
                return;
            }

            const source = await readFile(entryPath, 'utf8');
            for (const match of source.matchAll(protocolVersionPattern)) {
                const versionText = match[1];
                if (versionText !== undefined) {
                    declarations.push({
                        filePath: entryPath,
                        version: Number.parseInt(versionText, 10),
                    });
                }
            }
        }));
    }

    await visit(srcRoot);
    return declarations;
}

async function readText(filePath: string, missingMessage: string) {
    try {
        return await readFile(filePath, 'utf8');
    } catch {
        throw new Error(missingMessage);
    }
}

async function pathExists(filePath: string) {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

function getTomlSectionString(source: string, sectionName: string, key: string) {
    const section = getTomlSection(source, `[${sectionName}]`);
    return section === null ? null : getTomlString(section, key);
}

function getTomlArraySectionStrings(source: string, sectionName: string, key: string) {
    return Array.from(source.matchAll(new RegExp(`^\\s*\\[\\[${escapeRegExp(sectionName)}\\]\\]\\s*$`, 'gmu')))
        .flatMap((match) => {
            const index = match.index;
            if (index === undefined) {
                return [];
            }

            const section = source.slice(index + match[0].length);
            const nextSection = section.search(sectionHeadingPattern);
            const sectionSource = nextSection === -1 ? section : section.slice(0, nextSection);
            const value = getTomlString(sectionSource, key);
            return value === null ? [] : [value];
        });
}

function getTomlSection(source: string, heading: string) {
    const headingPattern = new RegExp(`^\\s*${escapeRegExp(heading)}\\s*$`, 'mu');
    const match = headingPattern.exec(source);
    if (match === null || match.index === undefined) {
        return null;
    }

    const section = source.slice(match.index + match[0].length);
    const nextSection = section.search(sectionHeadingPattern);
    return nextSection === -1 ? section : section.slice(0, nextSection);
}

function getTomlString(source: string, key: string) {
    const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]+)"\\s*$`, 'mu').exec(source);
    return match?.[1] ?? null;
}

function formatOptionalString(value: string | null) {
    return value === null ? '<missing>' : JSON.stringify(value);
}

function escapeRegExp(source: string) {
    return source.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const isDirectCliRun = process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    try {
        await checkNativeToolProtocols();
        console.log('Native tool protocol contracts match Rust sources and tests.');
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
