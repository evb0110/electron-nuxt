import {
    mkdirSync,
    readFileSync,
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

const FIXTURE_DIR = resolve(process.cwd(), '.devkit', 'tmp', 'e2e-fixtures');
const PROJECT_FIXTURE_DIR = resolve(process.cwd(), '.devkit', 'test-pdfs');

export interface IPdfAnnotationSummary {
    total: number;
    bySubtype: Record<string, number>;
}

function ensureFixtureDir() {
    mkdirSync(FIXTURE_DIR, { recursive: true });
}

export function createFixturePath(filename: string) {
    ensureFixtureDir();
    return join(FIXTURE_DIR, filename);
}

export function copyProjectFixture(sourceFilename: string, targetFilename?: string) {
    ensureFixtureDir();
    const sourcePath = join(PROJECT_FIXTURE_DIR, sourceFilename);
    const targetPath = join(FIXTURE_DIR, targetFilename ?? sourceFilename);
    writeFileSync(targetPath, readFileSync(sourcePath));
    return targetPath;
}

export async function createLinkOverlayFixturePdf(filename: string, url: string) {
    ensureFixtureDir();
    const filePath = join(FIXTURE_DIR, filename);

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
    const filePath = join(FIXTURE_DIR, filename);

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

export async function readPdfAnnotationSummary(filePath: string): Promise<IPdfAnnotationSummary> {
    const data = new Uint8Array(readFileSync(filePath));
    const document = await pdfjs.getDocument({ data }).promise;

    const summary: IPdfAnnotationSummary = {
        total: 0,
        bySubtype: {},
    };

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const annotations = await page.getAnnotations();

        summary.total += annotations.length;
        for (const annotation of annotations) {
            const key = (annotation.subtype ?? 'Unknown').trim();
            summary.bySubtype[key] = (summary.bySubtype[key] ?? 0) + 1;
        }
    }

    await document.destroy();
    return summary;
}

export function getFixtureName(path: string) {
    return basename(path);
}

