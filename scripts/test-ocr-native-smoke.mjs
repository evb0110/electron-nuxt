import {execFile} from 'node:child_process';
import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {
    PDFDocument,
    StandardFonts,
} from 'pdf-lib';

const execFileAsync = promisify(execFile);
const tesseract = process.env.EVB_TESSERACT_PATH ?? 'tesseract';
const pdftoppm = process.env.EVB_PDFTOPPM_PATH ?? 'pdftoppm';
const required = process.env.EVB_OCR_NATIVE_SMOKE_REQUIRED === '1';
const phrase = 'EVB Viewer Native OCR Smoke';
const workDir = await mkdtemp(join(tmpdir(), 'evb-ocr-native-smoke-'));

try {
    await execFileAsync(tesseract, ['--version'], {timeout: 10_000});
    const pdfPath = join(workDir, 'phrase.pdf');
    const imageBase = join(workDir, 'phrase');
    const imagePath = `${imageBase}.png`;
    const outputBase = join(workDir, 'result');
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([
        720,
        180,
    ]);
    page.drawText(phrase, {
        x: 36,
        y: 72,
        size: 42,
        font,
    });
    await writeFile(pdfPath, await pdf.save());
    await execFileAsync(pdftoppm, [
        '-f',
        '1',
        '-l',
        '1',
        '-r',
        '300',
        '-singlefile',
        '-png',
        pdfPath,
        imageBase,
    ], {timeout: 30_000});
    await execFileAsync(tesseract, [
        imagePath,
        outputBase,
        '-l',
        'eng',
        '--psm',
        '6',
    ], {timeout: 30_000});
    const recognized = (await readFile(`${outputBase}.txt`, 'utf8'))
        .toLowerCase()
        .replace(/[^a-z]+/gu, ' ')
        .trim();
    if (!recognized.includes('evb viewer native ocr smoke')) {
        throw new Error(`Unexpected OCR output: ${JSON.stringify(recognized)}`);
    }
    process.stdout.write('OCR native smoke passed\n');
} catch (error) {
    const missingExecutable = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
    if (missingExecutable && !required) {
        process.stdout.write(`OCR native smoke skipped: ${tesseract} is unavailable\n`);
    } else {
        throw error;
    }
} finally {
    await rm(workDir, {
        recursive: true,
        force: true,
    });
}
