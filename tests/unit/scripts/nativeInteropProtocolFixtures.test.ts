import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {normalizePdfNativeMutationSet} from '@pdf-core';

describe('native interop golden protocol fixtures', () => {
    it('keeps the TS mutation validator aligned with the Rust sidecar fixture', async () => {
        const fixturePath = resolve(process.cwd(), 'native/protocol-fixtures/pdf-page-ops-save-mutations.json');
        const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as unknown;
        const sidecarFixture = fixture as {placedImages: Array<Record<string, unknown>>};
        const [placedImage] = sidecarFixture.placedImages;
        expect(Object.keys(placedImage ?? {}).sort()).toEqual([
            'byteLength',
            'bytesPath',
            'height',
            'mimeType',
            'pageIndex',
            'rotationDegrees',
            'sha256',
            'width',
            'x',
            'y',
        ]);
        const normalized = normalizePdfNativeMutationSet({
            ...sidecarFixture,
            placedImages: sidecarFixture.placedImages.map(({
                bytesPath: _bytesPath,
                ...image
            }) => ({
                ...image,
                source: {
                    path: String(_bytesPath),
                    size: Number(sidecarFixture.placedImages[0]?.byteLength),
                    sha256: String(sidecarFixture.placedImages[0]?.sha256),
                    leaseId: 'golden-sidecar-lease',
                    revision: null,
                },
            })),
        }, 'golden fixture', {errorKind: 'error'});

        expect(normalized.placedImages).toHaveLength(1);
        expect(normalized.placedImages?.[0]).toMatchObject({
            mimeType: 'image/jpeg',
            pageIndex: 0,
        });
    });
});
