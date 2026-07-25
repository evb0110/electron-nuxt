import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import type { IOcrPdfPageRequest } from '@electron/ocr/worker/types';

const probe = vi.hoisted(() => {
    const state = {
        invocations: [] as string[][],
        textByPage: new Map<number, string>(),
        fail: false,
    };
    const runPdftotext = (_command: string, args: string[]) => {
        state.invocations.push(args);
        if (state.fail) {
            return Promise.reject(new Error('pdftotext exploded'));
        }
        const firstPage = Number(args[args.indexOf('-f') + 1]);
        const lastPage = Number(args[args.indexOf('-l') + 1]);
        const pages: string[] = [];
        for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
            pages.push(state.textByPage.get(pageNumber) ?? '');
        }
        return Promise.resolve({
            stdout: `${pages.join('\f')}\f`,
            stderr: '',
            exitCode: 0,
        });
    };
    return {
        state,
        runPdftotext,
    };
});

vi.mock('@electron/ocr/worker/runOcrCommand', () => ({runOcrCommand: probe.runPdftotext}));

const { selectOcrPagesForSupersession } = await import('@electron/ocr/worker/selectOcrPagesForSupersession');

let tempDir: string | null = null;

async function createSourcePdf(pageCount: number) {
    tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-supersession-'));
    const pdf = await PDFDocument.create();
    for (let page = 1; page <= pageCount; page += 1) {
        pdf.addPage([
            200,
            300,
        ]);
    }
    const path = join(tempDir, 'source.pdf');
    await writeFile(path, await pdf.save());
    return path;
}

function pageRequests(pageNumbers: readonly number[]): IOcrPdfPageRequest[] {
    return pageNumbers.map(pageNumber => ({
        pageNumber,
        languages: ['eng'],
    }));
}

function runSelection(
    sourcePdfPath: string,
    pageNumbers: readonly number[],
    logs: Array<[string, string]>,
) {
    return selectOcrPagesForSupersession({
        sourcePdfPath,
        documentRevisionToken: requireDocumentRevisionToken('revision-1'),
        pages: pageRequests(pageNumbers),
        supersessionPolicy: 'missing-only',
        pdftotextBinary: '/fake/pdftotext',
        log: (level, message) => {
            logs.push([
                level,
                message,
            ]);
        },
        signal: new AbortController().signal,
    });
}

afterEach(async () => {
    probe.state.invocations = [];
    probe.state.textByPage = new Map();
    probe.state.fail = false;
    if (tempDir) {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
        tempDir = null;
    }
});

describe('OCR supersession page selection', () => {
    it('probes existing text with one process per contiguous page run', async () => {
        const sourcePdfPath = await createSourcePdf(6);
        probe.state.textByPage = new Map([
            [
                1,
                'chapter one',
            ],
            [
                2,
                'chapter two',
            ],
            [
                4,
                'chapter four',
            ],
            [
                5,
                'chapter five',
            ],
            [
                6,
                'chapter six',
            ],
        ]);

        const contiguous = await runSelection(sourcePdfPath, [
            1,
            2,
            3,
            4,
            5,
            6,
        ], []);
        expect(probe.state.invocations).toHaveLength(1);
        expect(contiguous.pages.map(page => page.pageNumber)).toEqual([3]);

        probe.state.invocations = [];
        const sparse = await runSelection(sourcePdfPath, [
            1,
            2,
            5,
            6,
        ], []);
        expect(probe.state.invocations).toHaveLength(2);
        expect(sparse.pages).toEqual([]);
    });

    it('keeps the page to text mapping aligned across a batched probe', async () => {
        const sourcePdfPath = await createSourcePdf(5);
        probe.state.textByPage = new Map([[
            2,
            'only page two carries text',
        ]]);

        const selection = await runSelection(sourcePdfPath, [
            1,
            2,
            3,
            4,
            5,
        ], []);

        expect(selection.pages.map(page => page.pageNumber)).toEqual([
            1,
            3,
            4,
            5,
        ]);
        expect(selection.diagnostics).toEqual([{
            code: 'OCR_EXISTING_TEXT_SKIPPED',
            severity: 'info',
            pageNumber: 2,
            message: expect.stringContaining('native-text'),
        }]);
    });

    it('reports a failed text probe instead of silently treating pages as text bearing', async () => {
        const sourcePdfPath = await createSourcePdf(3);
        probe.state.fail = true;
        const logs: Array<[string, string]> = [];

        const selection = await runSelection(sourcePdfPath, [
            1,
            2,
            3,
        ], logs);

        expect(selection.pages).toEqual([]);
        expect(logs.some(([
            level,
            message,
        ]) => level === 'warn' && message.includes('pdftotext exploded'))).toBe(true);
        expect(selection.warnings.some(warning => warning.includes('pdftotext exploded'))).toBe(true);
    });

    it('reports a failed text visibility inspection instead of swallowing it', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-supersession-'));
        const sourcePdfPath = join(tempDir, 'broken.pdf');
        await writeFile(sourcePdfPath, 'not a pdf at all');
        probe.state.textByPage = new Map([[
            1,
            'existing text',
        ]]);
        const logs: Array<[string, string]> = [];

        const selection = await runSelection(sourcePdfPath, [1], logs);

        expect(selection.pages).toEqual([]);
        expect(logs.some(([
            level,
            message,
        ]) => level === 'warn' && message.includes('Text-visibility inspection failed'))).toBe(true);
        expect(selection.warnings.some(warning => warning.includes('Text-visibility inspection failed'))).toBe(true);
    });
});
