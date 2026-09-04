import { createHash } from 'node:crypto';
import {
    mkdtemp,
    readFile,
    rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
    FONTS_FIXTURE_PACK_ID,
    FONTS_FIXTURE_SCRIPTS,
    fontsFixtureMarkers,
    fontsFixtureUnicodeFileNames,
    generateFontsFixture,
} from '@scripts/windows-test/fixtures/generateFontsFixture';
import {
    METADATA_FIXTURE_FORM_FIELD_NAME,
    METADATA_FIXTURE_NAMED_DESTINATIONS,
    METADATA_FIXTURE_OUTLINE_TITLES,
    METADATA_FIXTURE_PAGE_COUNT,
    generateMetadataFixture,
    metadataFixtureMarkers,
} from '@scripts/windows-test/fixtures/generateMetadataFixture';
import {
    generateCorruptSidecarControl,
    generateNegativeControls,
} from '@scripts/windows-test/fixtures/generateNegativeControls';
import {
    NUMBERED_FIXTURE_PAGE_COUNT,
    generateNumberedFixture,
    numberedFixtureMarkers,
} from '@scripts/windows-test/fixtures/generateNumberedFixture';
import {
    WINDOWS_FIXTURE_GENERATED_DIRECTORY,
    parseWindowsFixtureCliArgs,
    runWindowsFixtureGeneration,
    runWindowsFixturesCli,
    windowsFixtureArtifacts,
} from '@scripts/windows-test/fixtures/generateWindowsFixturesCli';
import { evaluatePageMarkers } from '@scripts/windows-test/oracles/pageMarkerOracle';
import { loadPdfjsDocument } from '@scripts/windows-test/oracles/pdfjsNodeRuntime';
import { inspectPdfStructure } from '@scripts/windows-test/oracles/pdfStructureOracle';

const repositoryRoot = process.cwd();

const NON_ASCII = /[^ -~]/u;

const WIN_ANSI_ONLY = /^[ -ÿ]*$/u;

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory() {
    const directory = await mkdtemp(path.join(tmpdir(), 'evb-windows-fixtures-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterAll(async () => {
    for (const directory of temporaryDirectories) {
        await rm(directory, {
            recursive: true,
            force: true,
        });
    }
});

function sha256(bytes: Uint8Array) {
    return createHash('sha256').update(bytes).digest('hex');
}

describe('generateNumberedFixture', () => {
    let bytes: Uint8Array;

    beforeAll(async () => {
        bytes = await generateNumberedFixture();
    });

    it('produces twelve pages with the documented markers', async () => {
        const structure = await inspectPdfStructure(bytes);
        expect(structure.pageCount).toBe(NUMBERED_FIXTURE_PAGE_COUNT);
        expect(numberedFixtureMarkers()).toEqual([
            'EVB-F01-PAGE-01',
            'EVB-F01-PAGE-02',
            'EVB-F01-PAGE-03',
            'EVB-F01-PAGE-04',
            'EVB-F01-PAGE-05',
            'EVB-F01-PAGE-06',
            'EVB-F01-PAGE-07',
            'EVB-F01-PAGE-08',
            'EVB-F01-PAGE-09',
            'EVB-F01-PAGE-10',
            'EVB-F01-PAGE-11',
            'EVB-F01-PAGE-12',
        ]);
        const result = await evaluatePageMarkers(bytes, {
            repositoryRoot,
            expectedMarkers: numberedFixtureMarkers(),
        });
        expect(result.detail).toContain('markers appear');
        expect(result.status).toBe('passed');
    });

    it('is byte-for-byte stable across two generations', async () => {
        const second = await generateNumberedFixture();
        expect(sha256(second)).toBe(sha256(bytes));
        expect(second.byteLength).toBe(bytes.byteLength);
    });

    it('honours a requested page count', async () => {
        const short = await generateNumberedFixture({ pageCount: 3 });
        const structure = await inspectPdfStructure(short);
        expect(structure.pageCount).toBe(3);
    });
});

describe('generateMetadataFixture', () => {
    it('carries page labels, an outline, destinations, annotations and a form field', async () => {
        const bytes = await generateMetadataFixture();
        const structure = await inspectPdfStructure(bytes);
        expect(structure.pageCount).toBe(METADATA_FIXTURE_PAGE_COUNT);
        expect(structure.annotationCount).toBeGreaterThanOrEqual(2);
        const text = new TextDecoder('latin1').decode(bytes);
        for (const destination of METADATA_FIXTURE_NAMED_DESTINATIONS) {
            expect(text).toContain(destination);
        }
        const reloaded = await PDFDocument.load(bytes);
        expect(reloaded.getForm().getFields().map(field => field.getName())).toEqual([METADATA_FIXTURE_FORM_FIELD_NAME]);
        const document = await loadPdfjsDocument(bytes, { repositoryRoot });
        try {
            const outline = await document.getOutline();
            expect(outline?.map(entry => entry.title)).toEqual([...METADATA_FIXTURE_OUTLINE_TITLES]);
        } finally {
            await document.destroy();
        }
        expect(metadataFixtureMarkers()).toHaveLength(METADATA_FIXTURE_PAGE_COUNT);
    });

    it('is byte-for-byte stable across two generations', async () => {
        const first = await generateMetadataFixture();
        const second = await generateMetadataFixture();
        expect(sha256(second)).toBe(sha256(first));
    });
});

describe('generateFontsFixture', () => {
    it('keeps the Unicode strings and file names even though glyphs are transliterated', async () => {
        const bytes = await generateFontsFixture();
        const structure = await inspectPdfStructure(bytes);
        expect(FONTS_FIXTURE_PACK_ID).toBe('F04');
        expect(structure.pageCount).toBe(FONTS_FIXTURE_SCRIPTS.length);
        const fileNames = fontsFixtureUnicodeFileNames();
        expect(fileNames).toHaveLength(FONTS_FIXTURE_SCRIPTS.length);
        expect(fileNames.some(name => NON_ASCII.test(name))).toBe(true);
        expect(FONTS_FIXTURE_SCRIPTS.some(script => NON_ASCII.test(script.intendedText))).toBe(true);
        for (const script of FONTS_FIXTURE_SCRIPTS) {
            expect(WIN_ANSI_ONLY.test(script.winAnsiText)).toBe(true);
        }
        expect(fontsFixtureMarkers()).toHaveLength(FONTS_FIXTURE_SCRIPTS.length);
    });
});

describe('generateNegativeControls', () => {
    it('produces a blank page, wrong markers, truncated bytes and a corrupt sidecar', async () => {
        const controls = await generateNegativeControls();
        const blank = await inspectPdfStructure(controls.blankSinglePage);
        expect(blank.pageCount).toBe(1);
        const wrong = await inspectPdfStructure(controls.wrongPageMarkers);
        expect(wrong.pageCount).toBe(NUMBERED_FIXTURE_PAGE_COUNT);
        const good = await generateNumberedFixture();
        expect(controls.truncated.byteLength).toBeLessThan(good.byteLength);
        const sidecar: unknown = JSON.parse(controls.corruptSidecar);
        expect(sidecar).toBeTypeOf('object');
        expect(generateCorruptSidecarControl()).toBe(controls.corruptSidecar);
    });

    it('makes the wrong-marker control carry a different marker on every page', async () => {
        const controls = await generateNegativeControls();
        const result = await evaluatePageMarkers(controls.wrongPageMarkers, {
            repositoryRoot,
            expectedMarkers: numberedFixtureMarkers(),
        });
        expect(result.status).toBe('failed');
    });
});

describe('runWindowsFixtureGeneration', () => {
    it('writes nothing without the write flag', async () => {
        const directory = await createTemporaryDirectory();
        const result = await runWindowsFixtureGeneration({
            outputDirectory: path.join(directory, 'generated'),
            write: false,
        });
        expect(result.written).toBe(false);
        expect(result.entries).toHaveLength(windowsFixtureArtifacts().length);
        await expect(readFile(path.join(directory, 'generated', 'f01-numbered-12p.pdf'))).rejects.toThrow();
    });

    it('writes every artifact under --write and reports stable hashes', async () => {
        const first = await createTemporaryDirectory();
        const second = await createTemporaryDirectory();
        const firstRun = await runWindowsFixtureGeneration({
            outputDirectory: first,
            write: true,
            relativeTo: first,
        });
        const secondRun = await runWindowsFixtureGeneration({
            outputDirectory: second,
            write: true,
            relativeTo: second,
        });
        expect(firstRun.entries.map(entry => entry.sha256)).toEqual(
            secondRun.entries.map(entry => entry.sha256),
        );
        for (const entry of firstRun.entries) {
            const bytes = await readFile(path.join(first, entry.relativePath));
            expect(bytes.byteLength).toBe(entry.bytes);
            expect(sha256(bytes)).toBe(entry.sha256);
        }
    });
});

describe('parseWindowsFixtureCliArgs', () => {
    it('defaults to the tracked generated directory and requires --write', () => {
        const parsed = parseWindowsFixtureCliArgs([], '/repo');
        expect(parsed.write).toBe(false);
        expect(parsed.outputDirectory).toBe(path.join('/repo', WINDOWS_FIXTURE_GENERATED_DIRECTORY));
    });

    it('honours --out and --write', () => {
        const parsed = parseWindowsFixtureCliArgs([
            '--write',
            '--out=build/fixtures',
        ], '/repo');
        expect(parsed.write).toBe(true);
        expect(parsed.outputDirectory).toBe(path.resolve('/repo', 'build/fixtures'));
    });
});

describe('runWindowsFixturesCli', () => {
    it('logs a JSON report of every artifact', async () => {
        const directory = await createTemporaryDirectory();
        const lines: string[] = [];
        const result = await runWindowsFixturesCli({
            argv: [`--out=${path.join(directory, 'generated')}`],
            cwd: directory,
            log: message => lines.push(message),
        });
        expect(result.written).toBe(false);
        expect(lines).toHaveLength(1);
        const parsed: unknown = JSON.parse(lines[0] ?? '');
        expect(parsed).toMatchObject({ written: false });
    });
});
