#!/usr/bin/env node
import {
    appendFile,
    writeFile,
} from 'node:fs/promises';
import {
    PDFDocument,
    StandardFonts,
} from 'pdf-lib';

const [
    , , inputPath,
    outputBase,
] = process.argv;
if (!inputPath || !outputBase) {
    process.stderr.write('fake-tesseract requires input and output base\n');
    process.exit(2);
}

const pageMatch = inputPath.match(/-page-(\d+)(?:-|\.)/u);
const pageNumber = Number(pageMatch?.[1] ?? 1);
if (process.env.EVB_FAKE_OCR_CALL_LOG) {
    await appendFile(process.env.EVB_FAKE_OCR_CALL_LOG, `${pageNumber}\n`);
}
if (Number(process.env.EVB_FAKE_OCR_FAIL_PAGE) === pageNumber) {
    process.stderr.write(`deterministic crash on page ${pageNumber}\n`);
    process.exit(86);
}

const phrase = `checkpoint page ${pageNumber}`;
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
const page = pdf.addPage([
    600,
    800,
]);
page.drawText(phrase, {
    x: 36,
    y: 720,
    size: 18,
    font,
});
await writeFile(`${outputBase}.pdf`, await pdf.save());
await writeFile(`${outputBase}.tsv`, [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '4\t1\t1\t1\t1\t0\t20\t30\t300\t30\t-1\t',
    '5\t1\t1\t1\t1\t1\t20\t30\t120\t30\t95\tcheckpoint',
    '5\t1\t1\t1\t1\t2\t150\t30\t70\t30\t95\tpage',
    `5\t1\t1\t1\t1\t3\t230\t30\t30\t30\t95\t${pageNumber}`,
].join('\n'));
