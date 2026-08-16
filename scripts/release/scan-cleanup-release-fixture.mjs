import {
    existsSync,
    readFileSync,
} from 'node:fs';
import path from 'node:path';

export const DEFAULT_PACKAGED_SCAN_CLEANUP_FIXTURE = 'tests/fixtures/release/scan-cleanup-four-page-grayscale.pdf';
export const DEFAULT_PACKAGED_SCAN_CLEANUP_EXPECTED_PAGES = 4;

function positivePageCount(value, label) {
    const pageCount = Number.parseInt(String(value), 10);
    if (!Number.isInteger(pageCount) || pageCount < 1) {
        throw new Error(`${label} must be a positive integer`);
    }
    return pageCount;
}

function parseFixtureConfig(configPath) {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Packaged scan-cleanup fixture config must be an object: ${configPath}`);
    }
    const source = parsed.source;
    if (typeof source !== 'string' || source.trim() === '') {
        throw new Error(`Packaged scan-cleanup fixture config must set a source: ${configPath}`);
    }
    return {
        expectedPages: parsed.expectedPages === undefined
            ? DEFAULT_PACKAGED_SCAN_CLEANUP_EXPECTED_PAGES
            : positivePageCount(parsed.expectedPages, 'expectedPages'),
        source: source.trim(),
    };
}

export function getPackagedScanCleanupFixture({
    cwd = process.cwd(),
    env = process.env,
} = {}) {
    const fixtureOverride = env.EVB_RELEASE_SCAN_CLEANUP_FIXTURE?.trim();
    const configuredPath = env.EVB_RELEASE_SCAN_CLEANUP_FIXTURE_CONFIG?.trim()
        || path.join(cwd, '.devkit/scan-cleanup-release-fixture.json');
    const hasExplicitConfig = Boolean(env.EVB_RELEASE_SCAN_CLEANUP_FIXTURE_CONFIG?.trim());
    if (!fixtureOverride && hasExplicitConfig && !existsSync(configuredPath)) {
        throw new Error(`Packaged scan-cleanup fixture config is missing: ${configuredPath}`);
    }
    const config = !fixtureOverride && existsSync(configuredPath)
        ? parseFixtureConfig(configuredPath)
        : null;
    const source = fixtureOverride
        || config?.source
        || DEFAULT_PACKAGED_SCAN_CLEANUP_FIXTURE;
    const expectedPages = env.EVB_RELEASE_SCAN_CLEANUP_EXPECTED_PAGES?.trim()
        ? positivePageCount(env.EVB_RELEASE_SCAN_CLEANUP_EXPECTED_PAGES, 'EVB_RELEASE_SCAN_CLEANUP_EXPECTED_PAGES')
        : config?.expectedPages ?? DEFAULT_PACKAGED_SCAN_CLEANUP_EXPECTED_PAGES;
    const sourcePath = path.resolve(cwd, source);
    if (!existsSync(sourcePath)) {
        throw new Error(
            `Packaged scan-cleanup fixture is required but missing: ${sourcePath}`,
        );
    }
    return {
        expectedPages,
        sourcePath,
    };
}
