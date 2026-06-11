import {
    readdirSync,
    statSync,
} from 'fs';
import { resolve } from 'path';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const browserPlatformWiringTimeoutMs = 8_000;

function listFilesRecursive(path: string): string[] {
    try {
        return readdirSync(path)
            .flatMap((entry) => {
                const entryPath = resolve(path, entry);

                return statSync(entryPath).isDirectory()
                    ? listFilesRecursive(entryPath)
                    : [entryPath];
            });
    } catch {
        return [];
    }
}

describe('browser OCR capability', () => {
    it('does not ship browser Tesseract assets', () => {
        expect(listFilesRecursive(resolve(process.cwd(), 'public/tesseract'))).toEqual([]);
    });

    it('reports OCR as unavailable in browser runtime', async () => {
        const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');

        await expect(browserOcrCapability.getLanguages()).resolves.toEqual([]);
        await expect(browserOcrCapability.validateTools()).resolves.toMatchObject({
            valid: false,
            errors: ['Browser OCR is unavailable; use the desktop app to create searchable PDFs.'],
            tools: {
                tesseract: {
                    found: false,
                    path: 'browser:unavailable',
                },
                tessdata: {
                    found: false,
                    path: 'browser:unavailable',
                    languages: [],
                },
            },
        });
    });

    it('does not run recognition or create searchable PDFs in browser runtime', async () => {
        const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');

        await expect(browserOcrCapability.recognize({
            pageNumber: 3,
            imageData: new Uint8Array([1]),
            languages: ['eng'],
        })).resolves.toMatchObject({
            pageNumber: 3,
            success: false,
            text: '',
            errorEnvelope: { code: 'OCR_WORKER_UNAVAILABLE' },
        });

        await expect(browserOcrCapability.recognizeBatch([{
            pageNumber: 1,
            imageData: new Uint8Array([1]),
            languages: ['eng'],
        }], 'request-1')).resolves.toMatchObject({
            results: {},
            errors: ['Browser OCR is unavailable; use the desktop app to create searchable PDFs.'],
            errorEnvelope: { code: 'OCR_WORKER_UNAVAILABLE' },
        });

        await expect(browserOcrCapability.createSearchablePdf('/tmp/in.pdf', [{
            pageNumber: 1,
            languages: ['eng'],
        }], 'request-2')).resolves.toMatchObject({
            started: false,
            jobId: 'request-2',
            error: 'Browser OCR is unavailable; use the desktop app to create searchable PDFs.',
        });
    });

    it('keeps browser OCR event hooks inert', async () => {
        const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');
        const onProgress = vi.fn();
        const onComplete = vi.fn();

        const unsubscribeProgress = browserOcrCapability.onProgress(onProgress);
        const unsubscribeComplete = browserOcrCapability.onComplete(onComplete);
        await browserOcrCapability.installLanguages(['eng'], 'request-3');
        unsubscribeProgress();
        unsubscribeComplete();

        expect(onProgress).not.toHaveBeenCalled();
        expect(onComplete).not.toHaveBeenCalled();
    });

    it('wires the browser platform to the unavailable OCR capability', async () => {
        const { browserPlatformApi } = await import('@app/platform/browserPlatformApi');

        await expect(browserPlatformApi.ocr.createSearchablePdf('/tmp/source.pdf', [], 'request-4'))
            .resolves.toMatchObject({
                started: false,
                jobId: 'request-4',
                errorEnvelope: { code: 'OCR_WORKER_UNAVAILABLE' },
            });
    }, browserPlatformWiringTimeoutMs);
});
