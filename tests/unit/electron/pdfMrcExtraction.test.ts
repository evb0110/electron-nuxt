import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'fs/promises';
import {join} from 'path';
import {tmpdir} from 'os';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {extractPdfMrcLayersBatch} from '@electron/pdf/extractPdfMrcLayers';
import type {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';

const scratchDirectories: string[] = [];

async function createScratch() {
    const directory = await mkdtemp(join(tmpdir(), 'evb-mrc-extraction-test-'));
    scratchDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(scratchDirectories.splice(0).map(directory =>
        rm(directory, {
            recursive: true,
            force: true,
        }),
    ));
});

describe('batched PDF MRC extraction', () => {
    it('preserves compact JP2 foregrounds while decoding only MRC backgrounds', async () => {
        const scratch = await createScratch();
        const progress: Array<[number, number]> = [];
        const runCommand = vi.fn<typeof runNativeToolCommand>(async (command, args) => {
            if (command === '/qpdf') {
                return {
                    exitCode: 0,
                    stderr: '',
                    stdout: JSON.stringify({qpdf: [
                        {jsonversion: 2},
                        {
                            'obj:2 0 R': {stream: {dict: {'/SMask': '20 0 R'}}},
                            'obj:20 0 R': {stream: {dict: {
                                '/BitsPerComponent': 1,
                                '/Decode': [
                                    1,
                                    0,
                                ],
                                '/Filter': '/JBIG2Decode',
                            }}},
                            'obj:4 0 R': {stream: {dict: {'/SMask': '40 0 R'}}},
                            'obj:40 0 R': {stream: {dict: {
                                '/BitsPerComponent': 1,
                                '/Filter': '/JBIG2Decode',
                            }}},
                        },
                    ]}),
                };
            }
            if (args.includes('-list')) {
                return {
                    exitCode: 0,
                    stderr: '',
                    stdout: [
                        'page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio',
                        '11 0 image 706 1066 rgb 3 8 jpx no 1 0 120 120 1K 1%',
                        '11 1 image 2120 3202 rgb 3 8 jpx no 2 0 360 360 1K 1%',
                        '11 2 smask 2120 3202 gray 1 1 jbig2 no 2 0 360 360 1K 1%',
                        '12 3 image 706 1066 rgb 3 8 jpx no 3 0 120 120 1K 1%',
                        '12 4 image 2120 3202 rgb 3 8 jpx no 4 0 360 360 1K 1%',
                        '12 5 smask 2120 3202 gray 1 1 jbig2 no 4 0 360 360 1K 1%',
                    ].join('\n'),
                };
            }
            if (args.includes('-all')) {
                const prefix = args.at(-1)!;
                await Promise.all([
                    writeFile(`${prefix}-000.jp2`, 'BACKGROUND-11'),
                    writeFile(`${prefix}-001.jp2`, 'FOREGROUND-11'),
                    writeFile(`${prefix}-002.jb2e`, 'MASK-11'),
                    writeFile(`${prefix}-003.jp2`, 'BACKGROUND-12'),
                    writeFile(`${prefix}-004.jp2`, 'FOREGROUND-12'),
                    writeFile(`${prefix}-005.jb2e`, 'MASK-12'),
                ]);
                return {
                    exitCode: 0,
                    stderr: '',
                    stdout: '',
                };
            }
            const outputIndex = args.indexOf('--output');
            if (outputIndex !== -1) {
                await writeFile(args[outputIndex + 1]!, '%PDF-1.7\n%%EOF\n');
                return {
                    exitCode: 0,
                    stderr: '',
                    stdout: '',
                };
            }
            const decodedPrefix = args.at(-1)!;
            await Promise.all([
                writeFile(`${decodedPrefix}-1.ppm`, 'P6\n1 1\n255\n\xff\xff\xff'),
                writeFile(`${decodedPrefix}-2.ppm`, 'P6\n1 1\n255\n\xff\xff\xff'),
            ]);
            return {
                exitCode: 0,
                stderr: '',
                stdout: '',
            };
        });
        const targets = [
            11,
            12,
        ].map(pageNumber => ({
            pageNumber,
            backgroundOutputPath: join(scratch, `background-${String(pageNumber)}.ppm`),
            foregroundOutputPath: join(scratch, `foreground-${String(pageNumber)}.jp2`),
            selectionMaskOutputPath: join(scratch, `selection-${String(pageNumber)}.jb2e`),
        }));

        const result = await extractPdfMrcLayersBatch({
            pdfPath: '/source.pdf',
            targets,
            pdfimagesBinary: '/pdfimages',
            qpdfBinary: '/qpdf',
            pdfImageCombineBinary: '/combine',
            pdftoppmBinary: '/pdftoppm',
            runCommand,
            log: vi.fn(),
            onProgress: (completed, total) => progress.push([
                completed,
                total,
            ]),
        });

        expect([...result.keys()]).toEqual([
            11,
            12,
        ]);
        expect(runCommand).toHaveBeenCalledTimes(5);
        expect(runCommand.mock.calls.some(([
            ,
            args,
        ]) => args.includes('-png'))).toBe(false);
        expect(progress).toEqual([[
            2,
            2,
        ]]);
        expect(await readFile(targets[0]!.foregroundOutputPath, 'utf8')).toBe('FOREGROUND-11');
        expect(await readFile(targets[1]!.selectionMaskOutputPath, 'utf8')).toBe('MASK-12');
        expect(result.get(11)?.selectionMaskDecode).toBe('inverted');
        expect(result.get(12)?.selectionMaskDecode).toBe('default');
        expect(runCommand.mock.calls.some(([
            ,
            args,
        ]) => args.includes('-jpeg'))).toBe(false);
    });
});
