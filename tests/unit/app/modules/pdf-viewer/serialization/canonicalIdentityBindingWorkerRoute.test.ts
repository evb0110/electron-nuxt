import {readFile} from 'node:fs/promises';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('canonical annotation identity binding worker route', () => {
    it('keeps the full-document binder out of the renderer save transaction', async () => {
        const [
            saveTransactionSource,
            workerSource,
        ] = await Promise.all([
            readFile('app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction.ts', 'utf8'),
            readFile('app/modules/pdf-viewer/engine/pdfSerialization.worker.ts', 'utf8'),
        ]);

        expect(saveTransactionSource).toContain('bindCanonicalAnnotationIdentitiesOffThread(');
        expect(saveTransactionSource).not.toContain('bindCanonicalAnnotationIdentitiesInBytes(');
        expect(workerSource).toContain('bindCanonicalAnnotationIdentitiesInBytes(');
    });
});
