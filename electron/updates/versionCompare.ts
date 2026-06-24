export function normalizeVersion(version: string | null | undefined) {
    if (!version) {
        return '';
    }

    return version.trim().replace(/^v/i, '').split('+')[0] ?? '';
}

interface IComparableVersion {
    major: number;
    minor: number;
    patch: number;
    prerelease: string | null;
}

function parseComparableVersion(version: string): IComparableVersion | null {
    const normalized = normalizeVersion(version);
    if (!normalized) {
        return null;
    }

    const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/u.exec(normalized);
    if (!match?.[1]) {
        return null;
    }

    return {
        major: Number(match[1]),
        minor: Number(match[2] ?? 0),
        patch: Number(match[3] ?? 0),
        prerelease: match[4] ?? null,
    };
}

function comparePrereleaseIdentifier(left: string, right: string) {
    const leftIsNumber = /^\d+$/u.test(left);
    const rightIsNumber = /^\d+$/u.test(right);

    if (leftIsNumber && rightIsNumber) {
        return Math.sign(Number(left) - Number(right));
    }

    if (leftIsNumber) {
        return -1;
    }

    if (rightIsNumber) {
        return 1;
    }

    return Math.sign(left.localeCompare(right));
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
    const maxLength = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < maxLength; index += 1) {
        const leftPart = leftParts[index];
        const rightPart = rightParts[index];
        if (leftPart === undefined) {
            return -1;
        }
        if (rightPart === undefined) {
            return 1;
        }

        const comparison = comparePrereleaseIdentifier(leftPart, rightPart);
        if (comparison !== 0) {
            return comparison;
        }
    }

    return 0;
}

export function compareVersions(left: string, right: string) {
    const leftVersion = parseComparableVersion(left);
    const rightVersion = parseComparableVersion(right);
    if (!leftVersion || !rightVersion) {
        return normalizeVersion(left).localeCompare(normalizeVersion(right));
    }

    const numericComparisons = [
        leftVersion.major - rightVersion.major,
        leftVersion.minor - rightVersion.minor,
        leftVersion.patch - rightVersion.patch,
    ];
    for (const comparison of numericComparisons) {
        const normalized = Math.sign(comparison);
        if (normalized !== 0) {
            return normalized;
        }
    }

    return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}
