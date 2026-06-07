import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import {
    basename,
    join,
    resolve,
} from 'node:path';
import {
    PDFDocument,
    PDFName,
    PDFString,
    StandardFonts,
    rgb,
} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { getCurrentSessionName } from '@scripts/electron-run/electronRunSessionPaths';

const FIXTURE_ROOT_DIR = resolve(process.cwd(), '.devkit', 'tmp', 'e2e-fixtures');
const TRACKED_PROJECT_FIXTURE_DIR = resolve(process.cwd(), 'tests', 'fixtures', 'electron');
const LEGACY_PROJECT_FIXTURE_DIR = resolve(process.cwd(), '.devkit', 'test-pdfs');
const PROJECT_ROOT_FIXTURE_DIR = resolve(process.cwd(), '.devkit');
const LARGE_PDF_FIXTURE_ENV_VAR = 'EVB_E2E_LARGE_PDF_FIXTURE';
const DEFAULT_LARGE_PDF_FIXTURE = 'large-pdf-fixtures/turkish-english-lexicon-letter-bookmarks.pdf';
const DJVU_FIXTURE_ENV_VAR = 'EVB_E2E_DJVU_FIXTURE';
const DJVU_REQUIRE_ENV_VAR = 'EVB_E2E_REQUIRE_DJVU_FIXTURE';
const PDFJS_ERRORS_VERBOSITY = (
    pdfjs as typeof pdfjs & {VerbosityLevel?: {ERRORS?: number;};}
).VerbosityLevel?.ERRORS;

export interface IPdfAnnotationSummary {
    total: number;
    bySubtype: Record<string, number>;
}

export interface IPdfPageSnapshot {
    pageNumber: number;
    rotation: number;
    textSnippet: string;
}

function getFixtureDir(sessionName = getCurrentSessionName()) {
    const safeSessionName = sessionName.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
    return join(FIXTURE_ROOT_DIR, safeSessionName);
}

function ensureFixtureDir(sessionName = getCurrentSessionName()) {
    mkdirSync(getFixtureDir(sessionName), { recursive: true });
}

export function cleanupSessionFixtures(sessionName = getCurrentSessionName()) {
    rmSync(getFixtureDir(sessionName), {
        recursive: true,
        force: true,
    });
}

export function createFixturePath(filename: string) {
    ensureFixtureDir();
    return join(getFixtureDir(), filename);
}

export function copyProjectFixture(sourceFilename: string, targetFilename?: string) {
    ensureFixtureDir();
    const sourcePath = resolveProjectFixturePath(sourceFilename);
    const targetPath = join(getFixtureDir(), targetFilename ?? sourceFilename);
    writeFileSync(targetPath, readFileSync(sourcePath));
    return targetPath;
}

function resolveProjectFixturePath(sourceFilename: string) {
    const candidatePaths = [
        join(TRACKED_PROJECT_FIXTURE_DIR, sourceFilename),
        join(LEGACY_PROJECT_FIXTURE_DIR, sourceFilename),
    ];
    const sourcePath = candidatePaths.find(existsSync);

    if (sourcePath) {
        return sourcePath;
    }

    throw new Error(`Fixture does not exist in any known location: ${candidatePaths.join(', ')}`);
}

export function copyDevkitFixture(sourceRelativePath: string, targetFilename?: string) {
    ensureFixtureDir();
    const sourcePath = resolve(PROJECT_ROOT_FIXTURE_DIR, sourceRelativePath);
    if (!existsSync(sourcePath)) {
        throw new Error(`Fixture does not exist: ${sourcePath}`);
    }
    const targetPath = join(getFixtureDir(), targetFilename ?? basename(sourcePath));
    writeFileSync(targetPath, readFileSync(sourcePath));
    return targetPath;
}

export function resolveLargePdfFixturePath() {
    const overridePath = process.env[LARGE_PDF_FIXTURE_ENV_VAR]?.trim();
    const candidatePaths = overridePath
        ? [resolve(overridePath)]
        : [
            resolve(TRACKED_PROJECT_FIXTURE_DIR, DEFAULT_LARGE_PDF_FIXTURE),
            resolve(PROJECT_ROOT_FIXTURE_DIR, DEFAULT_LARGE_PDF_FIXTURE),
        ];
    const candidatePath = candidatePaths.find(candidate => existsSync(candidate) && statSync(candidate).isFile());

    if (!candidatePath) {
        return null;
    }
    return candidatePath;
}

export function copyLargePdfFixture(targetFilename?: string) {
    const sourcePath = resolveLargePdfFixturePath();
    if (!sourcePath) {
        throw new Error(
            `Large PDF fixture is not available. Set ${LARGE_PDF_FIXTURE_ENV_VAR}`
            + ` or place ${DEFAULT_LARGE_PDF_FIXTURE} under tests/fixtures/electron or .devkit.`,
        );
    }
    ensureFixtureDir();
    const targetPath = join(getFixtureDir(), targetFilename ?? basename(sourcePath));
    copyFileSync(sourcePath, targetPath);
    return targetPath;
}

export async function createLinkOverlayFixturePdf(filename: string, url: string) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);

    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([
        612,
        792,
    ]);

    const text = 'Open external link';
    const size = 22;
    const x = 80;
    const y = 650;
    const textWidth = font.widthOfTextAtSize(text, size);

    page.drawText(text, {
        x,
        y,
        size,
        font,
        color: rgb(0.1, 0.22, 0.9),
    });

    const action = doc.context.obj({
        Type: PDFName.of('Action'),
        S: PDFName.of('URI'),
        URI: PDFString.of(url),
    });
    const actionRef = doc.context.register(action);

    const linkAnnotation = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Link'),
        Rect: [
            x,
            y - 4,
            x + textWidth,
            y + size + 6,
        ],
        Border: [
            0,
            0,
            0,
        ],
        A: actionRef,
    });
    const linkAnnotationRef = doc.context.register(linkAnnotation);
    page.node.set(PDFName.of('Annots'), doc.context.obj([linkAnnotationRef]));

    const bytes = await doc.save();
    writeFileSync(filePath, bytes);

    return filePath;
}

export async function createMultiPageTextFixturePdf(filename: string, pageCount = 3) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);

    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const page = doc.addPage([
            612,
            792,
        ]);
        page.drawText(`E2E Multi Page Fixture ${pageNumber}/${pageCount}`, {
            x: 70,
            y: 710,
            size: 24,
            font,
            color: rgb(0.13, 0.13, 0.13),
        });
        page.drawText(`Page ${pageNumber} sample text for annotations`, {
            x: 70,
            y: 660,
            size: 16,
            font,
            color: rgb(0.22, 0.22, 0.22),
        });
    }

    const bytes = await doc.save();
    writeFileSync(filePath, bytes);

    return filePath;
}

export function createPngFixture(filename: string) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const bytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGElEQVR4nGP8z8Dw'
        + 'n4GBgYmBgQEAOgoCEVxTeGsAAAAASUVORK5CYII=',
        'base64',
    );
    writeFileSync(filePath, bytes);
    return filePath;
}

export async function createBlankFixturePdf(filename: string, pageCount = 1) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);

    const doc = await PDFDocument.create();
    for (let pageNumber = 0; pageNumber < pageCount; pageNumber += 1) {
        doc.addPage([
            612,
            792,
        ]);
    }

    const bytes = await doc.save();
    writeFileSync(filePath, bytes);

    return filePath;
}

export async function readPdfAnnotationSummary(filePath: string): Promise<IPdfAnnotationSummary> {
    const document = await openPdfWithLowVerbosity(filePath);

    const summary: IPdfAnnotationSummary = {
        total: 0,
        bySubtype: {},
    };

    try {
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
            const page = await document.getPage(pageNumber);
            const annotations = await page.getAnnotations();

            summary.total += annotations.length;
            for (const annotation of annotations) {
                const key = (annotation.subtype ?? 'Unknown').trim();
                summary.bySubtype[key] = (summary.bySubtype[key] ?? 0) + 1;
            }
        }
    } finally {
        await document.destroy();
    }

    return summary;
}

export async function readPdfPageSnapshots(filePath: string): Promise<IPdfPageSnapshot[]> {
    const document = await openPdfWithLowVerbosity(filePath);
    const pages: IPdfPageSnapshot[] = [];

    try {
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
            const page = await document.getPage(pageNumber);
            const textContent = await page.getTextContent();
            const snippet = textContent.items
                .map((item) => {
                    if (!('str' in item)) {
                        return '';
                    }
                    return String(item.str).trim();
                })
                .filter(Boolean)
                .slice(0, 8)
                .join(' ')
                .trim();

            pages.push({
                pageNumber,
                rotation: page.rotate ?? 0,
                textSnippet: snippet,
            });
        }
    } finally {
        await document.destroy();
    }

    return pages;
}

export function findDjvuFixturePath() {
    return resolveDjvuFixturePath().path;
}

export function isDjvuFixtureRequired() {
    return process.env[DJVU_REQUIRE_ENV_VAR] === '1';
}

export function resolveDjvuFixturePath() {
    const overridePath = process.env[DJVU_FIXTURE_ENV_VAR]?.trim();
    if (overridePath) {
        const absoluteOverridePath = resolve(overridePath);
        if (!existsSync(absoluteOverridePath)) {
            return {
                path: null,
                reason: `${DJVU_FIXTURE_ENV_VAR} points to a missing path: ${absoluteOverridePath}`,
            };
        }
        if (!statSync(absoluteOverridePath).isFile()) {
            return {
                path: null,
                reason: `${DJVU_FIXTURE_ENV_VAR} must point to a file: ${absoluteOverridePath}`,
            };
        }
        if (!hasDjvuExtension(absoluteOverridePath)) {
            return {
                path: null,
                reason: `${DJVU_FIXTURE_ENV_VAR} must point to a .djvu or .djv file: ${absoluteOverridePath}`,
            };
        }
        return {
            path: absoluteOverridePath,
            reason: `Using ${DJVU_FIXTURE_ENV_VAR}: ${absoluteOverridePath}`,
        };
    }

    const fixtureDir = resolve(PROJECT_ROOT_FIXTURE_DIR, 'pdfs');
    if (!existsSync(fixtureDir)) {
        return {
            path: null,
            reason: `DjVu fixture directory does not exist: ${fixtureDir}`,
        };
    }

    const candidates = readdirSync(fixtureDir)
        .filter(hasDjvuExtension)
        .sort((left, right) => left.localeCompare(right));

    for (const candidate of candidates) {
        const candidatePath = join(fixtureDir, candidate);
        if (statSync(candidatePath).isFile()) {
            return {
                path: candidatePath,
                reason: `Using DjVu fixture: ${candidatePath}`,
            };
        }
    }

    return {
        path: null,
        reason: `No .djvu or .djv fixtures found in ${fixtureDir}`,
    };
}

function hasDjvuExtension(path: string) {
    const lowerPath = path.toLowerCase();
    return lowerPath.endsWith('.djvu') || lowerPath.endsWith('.djv');
}

async function openPdfWithLowVerbosity(filePath: string) {
    const data = new Uint8Array(readFileSync(filePath));
    if (typeof PDFJS_ERRORS_VERBOSITY === 'number') {
        return pdfjs.getDocument({
            data,
            verbosity: PDFJS_ERRORS_VERBOSITY,
        }).promise;
    }
    return pdfjs.getDocument({ data }).promise;
}
