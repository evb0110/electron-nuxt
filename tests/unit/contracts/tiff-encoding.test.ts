import {
    describe,
    expect,
    it,
} from 'vitest';
import * as utifModule from 'utif';
import {
    buildTiffImageIfd,
    encodeTiffIfds,
    getTiffValueCount,
    measureTiffIfdSize,
} from '@contracts/tiff-encoding';

interface IUtifEncoderModule {
    _binBE: {
        writeUint(buffer: Uint8Array, offset: number, value: number): void;
        writeUshort(buffer: Uint8Array, offset: number, value: number): void;
    };
    _writeIFD(
        bin: IUtifEncoderModule['_binBE'],
        data: Uint8Array,
        offset: number,
        ifd: Record<string, unknown>,
    ): [number, number];
    ttypes: Record<number, number | undefined>;
}

const UTIF = utifModule as typeof utifModule & IUtifEncoderModule;

describe('tiff encoding helpers', () => {
    it('encodes a multi-page TIFF header', () => {
        const ifds = [
            buildTiffImageIfd({
                width: 1,
                height: 1,
                dataLength: 4,
            }, 8),
            buildTiffImageIfd({
                width: 2,
                height: 1,
                dataLength: 8,
            }, 12),
        ];

        const bytes = encodeTiffIfds(ifds, UTIF);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const firstIfdOffset = view.getUint32(4, false);
        const firstIfdEntryCount = view.getUint16(firstIfdOffset, false);
        const firstNextIfdOffset = view.getUint32(
            firstIfdOffset + 2 + (firstIfdEntryCount * 12),
            false,
        );
        const secondIfdEntryCount = view.getUint16(firstNextIfdOffset, false);
        const secondNextIfdOffset = view.getUint32(
            firstNextIfdOffset + 2 + (secondIfdEntryCount * 12),
            false,
        );

        expect(bytes[0]).toBe(77);
        expect(bytes[1]).toBe(77);
        expect(firstIfdOffset).toBeGreaterThan(0);
        expect(firstIfdEntryCount).toBeGreaterThan(0);
        expect(firstNextIfdOffset).toBeGreaterThan(firstIfdOffset);
        expect(secondIfdEntryCount).toBeGreaterThan(0);
        expect(secondNextIfdOffset).toBe(0);
    });

    it('measures TIFF IFD size using value counts from arrays and typed arrays', () => {
        expect(getTiffValueCount([
            1,
            2,
            3,
        ])).toBe(3);
        expect(getTiffValueCount(new Uint16Array([
            1,
            2,
        ]))).toBe(2);

        const size = measureTiffIfdSize({
            t256: [1],
            t257: [1],
            t258: [
                8,
                8,
                8,
                8,
            ],
            t259: [1],
            t262: [2],
            t273: [8],
            t277: [4],
            t278: [1],
            t279: [4],
            t282: [1],
            t283: [1],
            t284: [1],
            t286: [0],
            t287: [0],
            t296: [1],
            t305: ['EVB Viewer'],
            t338: [1],
        }, UTIF.ttypes);

        expect(size).toBeGreaterThan(0);
    });
});
