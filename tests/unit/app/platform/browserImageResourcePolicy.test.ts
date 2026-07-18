import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    ASSISTANT_IMAGE_RESOURCE_LIMITS,
    PDF_IMAGE_PLACEMENT_RESOURCE_LIMITS,
    probeBrowserImageFile,
} from '@app/platform/browser-api/browserImageResourcePolicy';

function fileLike(bytes: Uint8Array, name: string, type: string) {
    return {
        name,
        type,
        size: bytes.byteLength,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as File;
}

function pngBytes(width: number, height: number, frameCount?: number) {
    const bytes = new Uint8Array(8 + 25 + (frameCount === undefined ? 0 : 20));
    bytes.set([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
    ], 0);
    bytes.set([
        0,
        0,
        0,
        13,
    ], 8);
    bytes.set(new TextEncoder().encode('IHDR'), 12);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    if (frameCount !== undefined) {
        bytes.set([
            0,
            0,
            0,
            8,
        ], 33);
        bytes.set(new TextEncoder().encode('acTL'), 37);
        view.setUint32(41, frameCount);
    }
    return bytes;
}

function gifBytes(frameCount: number) {
    const header = new Uint8Array([
        ...new TextEncoder().encode('GIF89a'),
        1,
        0,
        1,
        0,
        0,
        0,
        0,
    ]);
    const frame = new Uint8Array([
        0x2c,
        0,
        0,
        0,
        0,
        1,
        0,
        1,
        0,
        0,
        2,
        1,
        0,
        0,
    ]);
    const bytes = new Uint8Array(header.byteLength + (frame.byteLength * frameCount) + 1);
    bytes.set(header);
    for (let index = 0; index < frameCount; index += 1) {
        bytes.set(frame, header.byteLength + (index * frame.byteLength));
    }
    bytes[bytes.byteLength - 1] = 0x3b;
    return bytes;
}

describe('browser image resource policy', () => {
    it('admits dimensions without decoding image pixels', async () => {
        await expect(probeBrowserImageFile(
            fileLike(pngBytes(4_000, 3_000), 'scan.png', 'image/png'),
            ASSISTANT_IMAGE_RESOURCE_LIMITS,
        )).resolves.toMatchObject({
            width: 4_000,
            height: 3_000,
            frameCount: 1,
        });
    });

    it('rejects excessive decoded pixels before browser decode', async () => {
        await expect(probeBrowserImageFile(
            fileLike(pngBytes(10_000, 10_000), 'huge.png', 'image/png'),
            ASSISTANT_IMAGE_RESOURCE_LIMITS,
        )).rejects.toThrow('ERR_BROWSER_IMAGE_DECODED_SIZE_TOO_LARGE');
    });

    it('reads APNG frame admission from acTL', async () => {
        await expect(probeBrowserImageFile(
            fileLike(pngBytes(32, 32, PDF_IMAGE_PLACEMENT_RESOURCE_LIMITS.maxFrames + 1), 'animated.apng', 'image/png'),
            PDF_IMAGE_PLACEMENT_RESOURCE_LIMITS,
        )).rejects.toThrow('ERR_BROWSER_IMAGE_FRAME_COUNT_TOO_LARGE');
    });

    it('counts GIF image blocks before creating a static browser preview', async () => {
        await expect(probeBrowserImageFile(
            fileLike(gifBytes(3), 'animated.gif', 'image/gif'),
            {
                ...ASSISTANT_IMAGE_RESOURCE_LIMITS,
                maxFrames: 2,
            },
        )).rejects.toThrow('ERR_BROWSER_IMAGE_FRAME_COUNT_TOO_LARGE');
    });

    it('caps SVG structure before rasterization', async () => {
        const source = `<svg width="10" height="10">${'<path d="M0 0"/>'.repeat(10)}</svg>`;
        const limits = {
            ...ASSISTANT_IMAGE_RESOURCE_LIMITS,
            maxSvgElements: 5,
        };
        await expect(probeBrowserImageFile(
            fileLike(new TextEncoder().encode(source), 'dense.svg', 'image/svg+xml'),
            limits,
        )).rejects.toThrow('ERR_BROWSER_IMAGE_SVG_COMPLEXITY_TOO_LARGE');
    });
});
