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

describe('browser OCR capability', {timeout: 20_000}, () => {
    it('does not ship browser Tesseract assets', () => {
        expect(listFilesRecursive(resolve(process.cwd(), 'public/tesseract'))).toEqual([]);
    });

    it('reports OCR as unavailable in browser runtime', async () => {
        const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');

        await expect(browserOcrCapability.getLanguages()).resolves.toEqual([]);
    });

    it('does not create searchable PDFs in browser runtime', async () => {
        const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');

        await expect(browserOcrCapability.createSearchablePdf('/tmp/in.pdf', [{
            pageNumber: 1,
            languages: ['eng'],
        }], 'request-2')).resolves.toMatchObject({
            started: false,
            jobId: 'request-2',
            installed: [],
            error: 'Browser OCR is unavailable; use the desktop app to create searchable PDFs.',
            errorEnvelope: { code: 'OCR_WORKER_UNAVAILABLE' },
        });
    });

    it('returns Electron-compatible unavailable shapes for browser-only OCR operations', async () => {
        const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');

        await expect(browserOcrCapability.cancel('request-5')).resolves.toMatchObject({
            canceled: false,
            reason: 'not-found',
            errorEnvelope: { code: 'OCR_WORKER_UNAVAILABLE' },
        });
        await expect(browserOcrCapability.acknowledgeResultFile('request-5')).resolves.toMatchObject({
            cleaned: false,
            errorEnvelope: { code: 'OCR_WORKER_UNAVAILABLE' },
        });
    });

    it('keeps browser OCR event hooks inert', async () => {
        const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');
        const onProgress = vi.fn();
        const onComplete = vi.fn();

        const unsubscribeProgress = browserOcrCapability.onProgress(onProgress);
        const unsubscribeComplete = browserOcrCapability.onComplete(onComplete);
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
