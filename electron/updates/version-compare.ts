export function normalizeVersion(version: string | null | undefined) {
    if (!version) {
        return '';
    }

    return version.trim().replace(/^v/i, '').split('-')[0] ?? '';
}

function versionParts(version: string) {
    const normalized = normalizeVersion(version);
    if (!normalized) {
        return [] as number[];
    }

    return normalized.split('.').map((segment) => {
        const parsed = Number.parseInt(segment, 10);
        return Number.isFinite(parsed) ? parsed : 0;
    });
}

export function compareVersions(left: string, right: string) {
    const leftParts = versionParts(left);
    const rightParts = versionParts(right);
    const maxLength = Math.max(leftParts.length, rightParts.length);

    for (let i = 0; i < maxLength; i += 1) {
        const leftValue = leftParts[i] ?? 0;
        const rightValue = rightParts[i] ?? 0;
        if (leftValue === rightValue) {
            continue;
        }
        return leftValue > rightValue ? 1 : -1;
    }

    return 0;
}
