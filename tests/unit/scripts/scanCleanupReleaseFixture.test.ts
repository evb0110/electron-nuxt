import {PDFDocument} from 'pdf-lib';
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    DEFAULT_PACKAGED_SCAN_CLEANUP_EXPECTED_PAGES,
    DEFAULT_PACKAGED_SCAN_CLEANUP_FIXTURE,
    getPackagedScanCleanupFixture,
} from '@scripts/release/scan-cleanup-release-fixture.mjs';

const projectRoot = process.cwd();

describe('packaged scan-cleanup release fixture', () => {
    it('keeps a checked-in four-page grayscale source as the fail-closed default', async () => {
        const fixture = getPackagedScanCleanupFixture({
            cwd: projectRoot,
            env: {},
        });
        const pdfBytes = readFileSync(fixture.sourcePath);
        const pdf = await PDFDocument.load(pdfBytes);
        const pdfSource = pdfBytes.toString('latin1');

        expect(fixture.sourcePath).toBe(path.resolve(projectRoot, DEFAULT_PACKAGED_SCAN_CLEANUP_FIXTURE));
        expect(fixture.expectedPages).toBe(DEFAULT_PACKAGED_SCAN_CLEANUP_EXPECTED_PAGES);
        expect(existsSync(fixture.sourcePath)).toBe(true);
        expect(pdf.getPageCount()).toBe(DEFAULT_PACKAGED_SCAN_CLEANUP_EXPECTED_PAGES);
        expect(pdfSource).toContain('/ColorSpace/DeviceGray');
        expect(pdfSource).not.toContain('/ColorSpace/DeviceRGB');
    });

    it('supports an explicit fixture and page-count override', () => {
        const fixture = getPackagedScanCleanupFixture({
            cwd: projectRoot,
            env: {
                EVB_RELEASE_SCAN_CLEANUP_EXPECTED_PAGES: '4',
                EVB_RELEASE_SCAN_CLEANUP_FIXTURE: DEFAULT_PACKAGED_SCAN_CLEANUP_FIXTURE,
            },
        });

        expect(fixture.expectedPages).toBe(4);
        expect(fixture.sourcePath).toBe(path.resolve(projectRoot, DEFAULT_PACKAGED_SCAN_CLEANUP_FIXTURE));
    });

    it.each([
        '4.5',
        '4pages',
        '0',
    ])('rejects a non-integer expected page count: %s', expectedPages => {
        expect(() => getPackagedScanCleanupFixture({
            cwd: projectRoot,
            env: {
                EVB_RELEASE_SCAN_CLEANUP_EXPECTED_PAGES: expectedPages,
                EVB_RELEASE_SCAN_CLEANUP_FIXTURE: DEFAULT_PACKAGED_SCAN_CLEANUP_FIXTURE,
            },
        })).toThrow('must be a positive integer');
    });

    it('requires a page count with an explicit fixture override', () => {
        expect(() => getPackagedScanCleanupFixture({
            cwd: projectRoot,
            env: {EVB_RELEASE_SCAN_CLEANUP_FIXTURE: DEFAULT_PACKAGED_SCAN_CLEANUP_FIXTURE},
        })).toThrow('EVB_RELEASE_SCAN_CLEANUP_EXPECTED_PAGES is required');
    });

    it('fails when the default source is absent instead of silently skipping verification', () => {
        const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'evb-release-fixture-'));
        try {
            expect(() => getPackagedScanCleanupFixture({
                cwd: temporaryRoot,
                env: {},
            })).toThrow('fixture is required but missing');
        } finally {
            rmSync(temporaryRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('supports the existing machine-local config override', () => {
        const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'evb-release-fixture-config-'));
        try {
            const sourcePath = path.join(temporaryRoot, 'fixture.pdf');
            const configPath = path.join(temporaryRoot, 'fixture.json');
            writeFileSync(sourcePath, readFileSync(path.resolve(projectRoot, DEFAULT_PACKAGED_SCAN_CLEANUP_FIXTURE)));
            writeFileSync(configPath, JSON.stringify({
                expectedPages: 4,
                source: sourcePath,
            }));

            const fixture = getPackagedScanCleanupFixture({
                cwd: temporaryRoot,
                env: {EVB_RELEASE_SCAN_CLEANUP_FIXTURE_CONFIG: configPath},
            });
            expect(fixture).toEqual({
                expectedPages: 4,
                sourcePath,
            });
        } finally {
            rmSync(temporaryRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});
