import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import type { PackageJson } from 'type-fest';

interface ISemver {
    major: number;
    minor: number;
    patch: number;
    prerelease: string | null;
}

interface IResolvedPackage {
    name: string;
    version: string;
}

export interface IPnpmLockfileIndex {
    overrides: Record<string, string>;
    resolvedPackages: Map<string, Set<string>>;
}

export interface IDependencyLockstepInput {
    lockfile: IPnpmLockfileIndex;
    packageJson: PackageJson;
}

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const VUE_LOCKSTEP_EXEMPTIONS = new Set(['@vue/devtools-api']);
const REQUIRED_VUE_OVERRIDE_PACKAGES = ['@vue/compiler-sfc'];
const INTLIFY_LOCKSTEP_PACKAGES = [
    '@intlify/core',
    '@intlify/core-base',
    '@intlify/message-compiler',
    '@intlify/shared',
];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function asStringRecord(value: unknown) {
    if (!isRecord(value)) {
        return {};
    }

    const entries: Array<[string, string]> = [];
    for (const [
        key,
        entryValue,
    ] of Object.entries(value)) {
        if (typeof entryValue === 'string') {
            entries.push([
                key,
                entryValue,
            ]);
        }
    }

    return Object.fromEntries(entries);
}

function getDependencies(packageJson: PackageJson) {
    return asStringRecord(packageJson.dependencies);
}

function getDevDependencies(packageJson: PackageJson) {
    return asStringRecord(packageJson.devDependencies);
}

function getOverrides(packageJson: PackageJson) {
    const pnpmConfig = isRecord(packageJson.pnpm) ? packageJson.pnpm : {};
    return asStringRecord(pnpmConfig.overrides);
}

function isExactVersion(value: string) {
    return EXACT_VERSION_PATTERN.test(value);
}

function isVueLockstepPackage(packageName: string) {
    return packageName.startsWith('@vue/') && !VUE_LOCKSTEP_EXEMPTIONS.has(packageName);
}

function parseSemver(version: string): ISemver | null {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version);
    if (match === null) {
        return null;
    }

    const [
        ,
        major,
        minor,
        patch,
        prerelease,
    ] = match;

    if (major === undefined || minor === undefined || patch === undefined) {
        return null;
    }

    return {
        major: Number(major),
        minor: Number(minor),
        patch: Number(patch),
        prerelease: prerelease ?? null,
    };
}

function compareIdentifiers(left: string, right: string) {
    const leftNumber = /^\d+$/u.test(left) ? Number(left) : null;
    const rightNumber = /^\d+$/u.test(right) ? Number(right) : null;

    if (leftNumber !== null && rightNumber !== null) {
        return Math.sign(leftNumber - rightNumber);
    }

    if (leftNumber !== null) {
        return -1;
    }

    if (rightNumber !== null) {
        return 1;
    }

    return left.localeCompare(right);
}

function comparePrerelease(left: string | null, right: string | null) {
    if (left === right) {
        return 0;
    }

    if (left === null) {
        return 1;
    }

    if (right === null) {
        return -1;
    }

    const leftParts = left.split('.');
    const rightParts = right.split('.');
    const length = Math.max(leftParts.length, rightParts.length);

    for (let index = 0; index < length; index += 1) {
        const leftPart = leftParts[index];
        const rightPart = rightParts[index];

        if (leftPart === undefined) {
            return -1;
        }

        if (rightPart === undefined) {
            return 1;
        }

        const comparison = compareIdentifiers(leftPart, rightPart);
        if (comparison !== 0) {
            return comparison;
        }
    }

    return 0;
}

function compareSemver(left: ISemver, right: ISemver) {
    if (left.major !== right.major) {
        return Math.sign(left.major - right.major);
    }

    if (left.minor !== right.minor) {
        return Math.sign(left.minor - right.minor);
    }

    if (left.patch !== right.patch) {
        return Math.sign(left.patch - right.patch);
    }

    return comparePrerelease(left.prerelease, right.prerelease);
}

function incrementForCaret(version: ISemver): ISemver {
    if (version.major > 0) {
        return {
            major: version.major + 1,
            minor: 0,
            patch: 0,
            prerelease: null,
        };
    }

    if (version.minor > 0) {
        return {
            major: 0,
            minor: version.minor + 1,
            patch: 0,
            prerelease: null,
        };
    }

    return {
        major: 0,
        minor: 0,
        patch: version.patch + 1,
        prerelease: null,
    };
}

function incrementForTilde(version: ISemver): ISemver {
    return {
        major: version.major,
        minor: version.minor + 1,
        patch: 0,
        prerelease: null,
    };
}

function isWithinLowerInclusiveUpperExclusive(version: ISemver, lower: ISemver, upper: ISemver) {
    return compareSemver(version, lower) >= 0 && compareSemver(version, upper) < 0;
}

function wildcardComparatorIncludes(range: string, version: ISemver) {
    const parts = range.split('.');
    const major = parts[0];
    const minor = parts[1];
    const patch = parts[2];

    if (major === undefined || /^[xX*]$/u.test(major)) {
        return true;
    }

    if (Number(major) !== version.major) {
        return false;
    }

    if (minor === undefined || /^[xX*]$/u.test(minor)) {
        return true;
    }

    if (Number(minor) !== version.minor) {
        return false;
    }

    if (patch === undefined || /^[xX*]$/u.test(patch)) {
        return true;
    }

    return Number(patch) === version.patch;
}

function comparatorIncludesVersion(comparator: string, version: ISemver) {
    if (comparator === '' || comparator === '*' || /^[xX]$/u.test(comparator)) {
        return true;
    }

    if (/[xX*]/u.test(comparator)) {
        return wildcardComparatorIncludes(comparator, version);
    }

    const match = /^(<=|>=|<|>|=)?\s*(.+)$/u.exec(comparator);
    if (match === null) {
        return false;
    }

    const [
        ,
        operator = '=',
        rawExpected,
    ] = match;

    if (rawExpected === undefined) {
        return false;
    }

    const expected = parseSemver(rawExpected);
    if (expected === null) {
        return false;
    }

    const comparison = compareSemver(version, expected);

    switch (operator) {
        case '<':
            return comparison < 0;
        case '<=':
            return comparison <= 0;
        case '>':
            return comparison > 0;
        case '>=':
            return comparison >= 0;
        case '=':
            return comparison === 0;
        default:
            return false;
    }
}

function rangePartIncludesVersion(rangePart: string, version: ISemver) {
    if (rangePart === '' || rangePart === '*' || /^[xX]$/u.test(rangePart)) {
        return true;
    }

    if (rangePart.startsWith('^')) {
        const lower = parseSemver(rangePart.slice(1));
        return lower !== null && isWithinLowerInclusiveUpperExclusive(version, lower, incrementForCaret(lower));
    }

    if (rangePart.startsWith('~')) {
        const lower = parseSemver(rangePart.slice(1));
        return lower !== null && isWithinLowerInclusiveUpperExclusive(version, lower, incrementForTilde(lower));
    }

    return rangePart
        .split(/\s+/u)
        .filter(Boolean)
        .every((comparator) => comparatorIncludesVersion(comparator, version));
}

export function versionRangeIncludesVersion(range: string, version: string) {
    const parsedVersion = parseSemver(version);
    if (parsedVersion === null) {
        return false;
    }

    return range
        .split('||')
        .map((rangePart) => rangePart.trim())
        .some((rangePart) => rangePartIncludesVersion(rangePart, parsedVersion));
}

function stripYamlScalar(value: string) {
    const trimmed = value.trim();
    if (trimmed.startsWith('\'') && trimmed.endsWith('\'')) {
        return trimmed.slice(1, -1).replace(/''/gu, '\'');
    }

    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1);
    }

    return trimmed;
}

function parseYamlMapEntry(line: string) {
    if (!line.startsWith('  ') || line.startsWith('    ')) {
        return null;
    }

    const rest = line.slice(2);
    if (rest.startsWith('\'')) {
        const quoteEnd = rest.indexOf('\'', 1);
        if (quoteEnd === -1 || rest[quoteEnd + 1] !== ':') {
            return null;
        }

        return {
            key: stripYamlScalar(rest.slice(0, quoteEnd + 1)),
            value: rest.slice(quoteEnd + 2).trim(),
        };
    }

    if (rest.startsWith('"')) {
        const quoteEnd = rest.indexOf('"', 1);
        if (quoteEnd === -1 || rest[quoteEnd + 1] !== ':') {
            return null;
        }

        return {
            key: stripYamlScalar(rest.slice(0, quoteEnd + 1)),
            value: rest.slice(quoteEnd + 2).trim(),
        };
    }

    const colonIndex = rest.indexOf(':');
    if (colonIndex === -1) {
        return null;
    }

    return {
        key: stripYamlScalar(rest.slice(0, colonIndex)),
        value: rest.slice(colonIndex + 1).trim(),
    };
}

function getLockfileTopLevelSection(line: string) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*$/u.exec(line);
    return match?.[1] ?? null;
}

function parseLockfilePackageKey(rawKey: string): IResolvedPackage | null {
    const key = rawKey.startsWith('/') ? rawKey.slice(1) : rawKey;
    if (key.startsWith('@')) {
        const slashIndex = key.indexOf('/');
        if (slashIndex === -1) {
            return null;
        }

        const versionSeparatorIndex = key.indexOf('@', slashIndex + 1);
        if (versionSeparatorIndex === -1) {
            return null;
        }

        return {
            name: key.slice(0, versionSeparatorIndex),
            version: key.slice(versionSeparatorIndex + 1).split('(')[0] ?? '',
        };
    }

    const versionSeparatorIndex = key.indexOf('@');
    if (versionSeparatorIndex <= 0) {
        return null;
    }

    return {
        name: key.slice(0, versionSeparatorIndex),
        version: key.slice(versionSeparatorIndex + 1).split('(')[0] ?? '',
    };
}

function addResolvedPackage(resolvedPackages: Map<string, Set<string>>, packageKey: string) {
    const resolvedPackage = parseLockfilePackageKey(packageKey);
    if (resolvedPackage === null || resolvedPackage.version === '') {
        return;
    }

    const versions = resolvedPackages.get(resolvedPackage.name) ?? new Set<string>();
    versions.add(resolvedPackage.version);
    resolvedPackages.set(resolvedPackage.name, versions);
}

export function parsePnpmLockfile(lockfileContent: string): IPnpmLockfileIndex {
    const overrides: Record<string, string> = {};
    const resolvedPackages = new Map<string, Set<string>>();
    let section: string | null = null;

    for (const line of lockfileContent.split(/\r?\n/u)) {
        const nextSection = getLockfileTopLevelSection(line);
        if (nextSection !== null) {
            section = nextSection;
            continue;
        }

        if (section !== 'overrides' && section !== 'packages' && section !== 'snapshots') {
            continue;
        }

        const entry = parseYamlMapEntry(line);
        if (entry === null) {
            continue;
        }

        if (section === 'overrides') {
            overrides[entry.key] = stripYamlScalar(entry.value);
            continue;
        }

        addResolvedPackage(resolvedPackages, entry.key);
    }

    return {
        overrides,
        resolvedPackages,
    };
}

function getOverrideTargetPackageName(overrideKey: string) {
    const target = overrideKey.split('>').pop()?.trim() ?? overrideKey.trim();

    if (target.startsWith('@')) {
        const slashIndex = target.indexOf('/');
        if (slashIndex === -1) {
            return target;
        }

        const versionIndex = target.indexOf('@', slashIndex + 1);
        return versionIndex === -1 ? target : target.slice(0, versionIndex);
    }

    const versionIndex = target.indexOf('@');
    return versionIndex <= 0 ? target : target.slice(0, versionIndex);
}

function collectDeclaredDependencies(packageJson: PackageJson) {
    return {
        ...getDependencies(packageJson),
        ...getDevDependencies(packageJson),
    };
}

function sortedEntries(record: Record<string, string>) {
    return Object.entries(record)
        .sort(([left], [right]) => left.localeCompare(right));
}

function formatVersions(versions: Set<string> | undefined) {
    return versions === undefined || versions.size === 0
        ? '<none>'
        : [...versions].sort().join(', ');
}

function assertVueLockstep(packageJson: PackageJson, errors: string[]) {
    const dependencies = getDependencies(packageJson);
    const declaredDependencies = collectDeclaredDependencies(packageJson);
    const overrides = getOverrides(packageJson);
    const vueVersion = dependencies.vue;

    if (vueVersion === undefined) {
        errors.push('dependencies.vue must be present as the Vue lockstep anchor.');
        return;
    }

    if (!isExactVersion(vueVersion)) {
        errors.push(`dependencies.vue must be exact-pinned, received "${vueVersion}".`);
        return;
    }

    for (const [
        packageName,
        specifier,
    ] of sortedEntries(declaredDependencies)) {
        if (!isVueLockstepPackage(packageName) || specifier === vueVersion) {
            continue;
        }

        errors.push(`${packageName} must match dependencies.vue (${vueVersion}), received "${specifier}".`);
    }

    for (const requiredOverride of REQUIRED_VUE_OVERRIDE_PACKAGES) {
        if (overrides[requiredOverride] === undefined) {
            errors.push(`pnpm.overrides.${requiredOverride} must be present and match dependencies.vue (${vueVersion}).`);
        }
    }

    for (const [
        overrideKey,
        overrideValue,
    ] of sortedEntries(overrides)) {
        const packageName = getOverrideTargetPackageName(overrideKey);
        if (!isVueLockstepPackage(packageName) || overrideValue === vueVersion) {
            continue;
        }

        errors.push(`pnpm.overrides.${overrideKey} must match dependencies.vue (${vueVersion}), received "${overrideValue}".`);
    }
}

function assertIntlifyLockstep(packageJson: PackageJson, errors: string[]) {
    const dependencies = getDependencies(packageJson);
    const declaredDependencies = collectDeclaredDependencies(packageJson);
    const intlifyVersion = dependencies['@intlify/core'];

    if (intlifyVersion === undefined) {
        errors.push('dependencies.@intlify/core must be present as the intlify runtime lockstep anchor.');
        return;
    }

    if (!isExactVersion(intlifyVersion)) {
        errors.push(`dependencies.@intlify/core must be exact-pinned, received "${intlifyVersion}".`);
        return;
    }

    for (const packageName of INTLIFY_LOCKSTEP_PACKAGES) {
        const specifier = dependencies[packageName];
        if (specifier === undefined) {
            errors.push(`dependencies.${packageName} must be present and match @intlify/core (${intlifyVersion}).`);
            continue;
        }

        if (specifier !== intlifyVersion) {
            errors.push(`${packageName} must match @intlify/core (${intlifyVersion}), received "${specifier}".`);
        }
    }

    const vueI18nRange = declaredDependencies['vue-i18n'];
    if (vueI18nRange === undefined) {
        errors.push(`vue-i18n must be declared with a range that includes intlify runtime ${intlifyVersion}.`);
        return;
    }

    if (!versionRangeIncludesVersion(vueI18nRange, intlifyVersion)) {
        errors.push(`vue-i18n range "${vueI18nRange}" must include intlify runtime ${intlifyVersion}.`);
    }
}

function assertOverrideGraph(packageJson: PackageJson, lockfile: IPnpmLockfileIndex, errors: string[]) {
    const overrides = getOverrides(packageJson);
    const packageOverrideEntries = sortedEntries(overrides);
    const lockfileOverrideEntries = sortedEntries(lockfile.overrides);

    for (const [
        overrideKey,
        overrideValue,
    ] of packageOverrideEntries) {
        const lockfileValue = lockfile.overrides[overrideKey];
        if (lockfileValue !== overrideValue) {
            errors.push(`pnpm-lock.yaml override ${overrideKey} must match package.json value "${overrideValue}", received "${lockfileValue ?? '<missing>'}".`);
        }

        const targetPackageName = getOverrideTargetPackageName(overrideKey);
        const resolvedVersions = lockfile.resolvedPackages.get(targetPackageName);
        if (resolvedVersions === undefined) {
            errors.push(`pnpm.overrides.${overrideKey} targets ${targetPackageName}, but that package is not resolved in pnpm-lock.yaml.`);
            continue;
        }

        if (isExactVersion(overrideValue) && !resolvedVersions.has(overrideValue)) {
            errors.push(`pnpm.overrides.${overrideKey} pins ${overrideValue}, but pnpm-lock.yaml resolves ${targetPackageName} at ${formatVersions(resolvedVersions)}.`);
        }
    }

    for (const [
        overrideKey,
        lockfileValue,
    ] of lockfileOverrideEntries) {
        if (overrides[overrideKey] === undefined) {
            errors.push(`pnpm-lock.yaml contains override ${overrideKey}: ${lockfileValue}, but package.json does not.`);
        }
    }
}

export function checkDependencyLockstep(input: IDependencyLockstepInput) {
    const errors: string[] = [];

    assertVueLockstep(input.packageJson, errors);
    assertIntlifyLockstep(input.packageJson, errors);
    assertOverrideGraph(input.packageJson, input.lockfile, errors);

    return errors;
}

async function readPackageJson(packageJsonPath: string) {
    const parsed: unknown = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    if (!isRecord(parsed)) {
        return {};
    }
    return parsed as PackageJson;
}

async function main() {
    const packageJson = await readPackageJson(path.join(PROJECT_ROOT, 'package.json'));
    const lockfileContent = await readFile(path.join(PROJECT_ROOT, 'pnpm-lock.yaml'), 'utf8');
    const errors = checkDependencyLockstep({
        lockfile: parsePnpmLockfile(lockfileContent),
        packageJson,
    });

    if (errors.length > 0) {
        console.error('Dependency lockstep check failed.');
        for (const error of errors) {
            console.error(`- ${error}`);
        }
        process.exitCode = 1;
        return;
    }

    console.log('Dependency lockstep check passed.');
}

function isDirectExecution() {
    const entryFilePath = process.argv[1];
    return entryFilePath !== undefined && pathToFileURL(path.resolve(entryFilePath)).href === import.meta.url;
}

if (isDirectExecution()) {
    main().catch((error: unknown) => {
        console.error('Failed to check dependency lockstep:', error);
        process.exitCode = 1;
    });
}
