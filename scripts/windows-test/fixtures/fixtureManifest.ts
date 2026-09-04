import { createHash } from 'node:crypto';
import {
    readFile,
    stat,
} from 'node:fs/promises';
import path from 'node:path';
import {
    isErrnoException,
    isOneOf,
    isRecord,
    isStringArray,
} from '@contracts/runtimeGuards';
import { WINDOWS_TEST_SCHEMA_VERSION } from '@scripts/windows-test/contracts/windowsTestContracts';

export const windowsFixtureLicenses = [
    'synthetic',
    'repository-tracked',
] as const;

export type TWindowsFixtureLicense = typeof windowsFixtureLicenses[number];

export const WINDOWS_FIXTURE_PACK_ID_PATTERN = /^F\d{2}$/u;

export interface IWindowsFixtureFile {
    id: string;
    path: string;
    bytes: number;
    sha256: string | null;
    expectedPages: number | null;
    markers: string[];
    generated: boolean;
    note?: string;
}

export interface IWindowsFixturePack {
    id: string;
    name: string;
    purpose: string;
    license: TWindowsFixtureLicense;
    publishable: boolean;
    provenance: string;
    variants: string[];
    metadata: Record<string, string>;
    files: IWindowsFixtureFile[];
}

export interface IWindowsFixtureManifest {
    schemaVersion: typeof WINDOWS_TEST_SCHEMA_VERSION;
    packs: IWindowsFixturePack[];
}

export interface IFixtureVerificationProblem {
    fixtureId: string;
    message: string;
}

export interface IFixtureVerificationResult {
    ok: boolean;
    verified: string[];
    skipped: string[];
    problems: IFixtureVerificationProblem[];
}

function isStringRecord(value: unknown): value is Record<string, string> {
    return isRecord(value) && Object.values(value).every(entry => typeof entry === 'string');
}

function isFixtureFile(value: unknown): value is IWindowsFixtureFile {
    return isRecord(value)
        && typeof value.id === 'string'
        && typeof value.path === 'string'
        && typeof value.bytes === 'number'
        && Number.isInteger(value.bytes)
        && (value.sha256 === null || (typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(value.sha256)))
        && (value.expectedPages === null || (typeof value.expectedPages === 'number' && Number.isInteger(value.expectedPages)))
        && isStringArray(value.markers)
        && typeof value.generated === 'boolean'
        && (value.note === undefined || typeof value.note === 'string');
}

function isFixturePack(value: unknown): value is IWindowsFixturePack {
    return isRecord(value)
        && typeof value.id === 'string'
        && WINDOWS_FIXTURE_PACK_ID_PATTERN.test(value.id)
        && typeof value.name === 'string'
        && typeof value.purpose === 'string'
        && isOneOf(windowsFixtureLicenses, value.license)
        && typeof value.publishable === 'boolean'
        && typeof value.provenance === 'string'
        && isStringArray(value.variants)
        && isStringRecord(value.metadata)
        && Array.isArray(value.files)
        && value.files.every(isFixtureFile);
}

export function isWindowsFixtureManifest(value: unknown): value is IWindowsFixtureManifest {
    return isRecord(value)
        && value.schemaVersion === WINDOWS_TEST_SCHEMA_VERSION
        && Array.isArray(value.packs)
        && value.packs.every(isFixturePack);
}

export async function loadFixtureManifest(manifestPath: string) {
    const raw = await readFile(manifestPath, 'utf8');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Windows fixture manifest at ${manifestPath} is not valid JSON: ${detail}`);
    }
    if (!isWindowsFixtureManifest(parsed)) {
        throw new Error(`Windows fixture manifest at ${manifestPath} does not match the expected schema.`);
    }
    return parsed;
}

/**
 * Hashes the manifest's fixture identity, not its prose, so a purpose reword
 * cannot invalidate a staged fixture cache while a changed hash or byte size
 * always does.
 */
export function computeFixtureManifestSha256(manifest: IWindowsFixtureManifest) {
    const canonical = manifest.packs
        .map(pack => ({
            id: pack.id,
            license: pack.license,
            publishable: pack.publishable,
            files: pack.files
                .map(file => ({
                    id: file.id,
                    path: file.path,
                    bytes: file.bytes,
                    sha256: file.sha256,
                    expectedPages: file.expectedPages,
                    markers: [...file.markers],
                }))
                .sort((first, second) => first.id.localeCompare(second.id)),
        }))
        .sort((first, second) => first.id.localeCompare(second.id));
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function collectFixturePackIds(manifest: IWindowsFixtureManifest) {
    return manifest.packs.map(pack => pack.id);
}

export function findFixturePack(manifest: IWindowsFixtureManifest, packId: string) {
    return manifest.packs.find(pack => pack.id === packId) ?? null;
}

async function verifyFixtureFile(
    baseDirectory: string,
    file: IWindowsFixtureFile,
    result: IFixtureVerificationResult,
) {
    const absolutePath = path.resolve(baseDirectory, file.path);
    let bytes: Buffer;
    try {
        const stats = await stat(absolutePath);
        if (!stats.isFile()) {
            result.problems.push({
                fixtureId: file.id,
                message: `${file.path} is not a regular file.`,
            });
            return;
        }
        bytes = await readFile(absolutePath);
    } catch (error) {
        const missing = isErrnoException(error) && error.code === 'ENOENT';
        if (missing && file.generated) {
            result.skipped.push(file.id);
            return;
        }
        result.problems.push({
            fixtureId: file.id,
            message: missing
                ? `${file.path} is missing.`
                : `${file.path} could not be read: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
    }
    if (bytes.byteLength !== file.bytes) {
        result.problems.push({
            fixtureId: file.id,
            message: `${file.path} is ${bytes.byteLength} bytes, expected ${file.bytes}.`,
        });
        return;
    }
    if (file.sha256 === null) {
        result.skipped.push(file.id);
        return;
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== file.sha256) {
        result.problems.push({
            fixtureId: file.id,
            message: `${file.path} hashes to ${actual}, expected ${file.sha256}.`,
        });
        return;
    }
    result.verified.push(file.id);
}

export async function verifyFixturePack(
    baseDirectory: string,
    manifest: IWindowsFixtureManifest,
    packIds?: readonly string[],
): Promise<IFixtureVerificationResult> {
    const result: IFixtureVerificationResult = {
        ok: true,
        verified: [],
        skipped: [],
        problems: [],
    };
    const packs = packIds === undefined
        ? manifest.packs
        : manifest.packs.filter(pack => packIds.includes(pack.id));
    for (const requestedId of packIds ?? []) {
        if (!packs.some(pack => pack.id === requestedId)) {
            result.problems.push({
                fixtureId: requestedId,
                message: 'Fixture pack is not declared in the manifest.',
            });
        }
    }
    for (const pack of packs) {
        for (const file of pack.files) {
            await verifyFixtureFile(baseDirectory, file, result);
        }
    }
    result.ok = result.problems.length === 0;
    return result;
}
