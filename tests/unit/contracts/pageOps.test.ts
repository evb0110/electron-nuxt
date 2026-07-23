import {
    describe,
    expect,
    it,
} from 'vitest';
import { PAGE_OPS_PLATFORM_FEATURE } from '@contracts/pageOpsPlatformFeature';

describe('page ops platform feature schemas', () => {
    const channels = PAGE_OPS_PLATFORM_FEATURE.invokeChannels;
    const codecs = PAGE_OPS_PLATFORM_FEATURE.ipcCodecs;

    it('preserves every async channel without an event layer', () => {
        expect(channels).toEqual({
            delete: 'page-ops:delete',
            extract: 'page-ops:extract',
            reorder: 'page-ops:reorder',
            insert: 'page-ops:insert',
            insertFile: 'page-ops:insert-file',
            rotate: 'page-ops:rotate',
            crop: 'page-ops:crop',
            removeCrop: 'page-ops:remove-crop',
            getPageGeometry: 'page-ops:get-page-geometry',
        });
        expect(PAGE_OPS_PLATFORM_FEATURE.eventChannels).toEqual({});
        expect(PAGE_OPS_PLATFORM_FEATURE.platformDescriptors.methods).toHaveLength(9);
    });

    it('round-trips mutation tuples and normalizes revision options', () => {
        const input = [
            '/tmp/work.pdf',
            [1],
            3,
            90,
            {
                expectedDocumentRevisionToken: ' drt1:test ',
                metadataSnapshot: {
                    pageLabels: ['i'],
                    bookmarks: [],
                    untitledBookmarkLabel: 'Untitled',
                },
            },
        ];
        const codec = codecs[channels.rotate]!;

        const decoded = codec.decodeArgs(codec.encodeArgs(input));
        expect(decoded.slice(0, 4)).toEqual([
            '/tmp/work.pdf',
            [1],
            3,
            90,
        ]);
        expect(decoded[4]).toMatchObject({
            expectedDocumentRevisionToken: 'drt1:test',
            metadataSnapshot: {pageLabels: ['i']},
        });
    });

    it('keeps malformed tuple and result messages stable', () => {
        expect(() => codecs[channels.rotate]!.decodeArgs([
            '/tmp/work.pdf',
            [1],
            3,
            45,
            undefined,
        ])).toThrow('angle must be 90, 180, or 270');
        expect(() => codecs[channels.delete]!.decodeArgs([
            '/tmp/work.pdf',
            [1],
            3,
        ])).toThrow('expected 4 arguments, received 3');
        expect(() => codecs[channels.rotate]!.decodeResult({success: 'yes'}))
            .toThrow('page operation result must include success');
        expect(() => codecs[channels.getPageGeometry]!.decodeResult({
            mediaBox: {
                x: 0,
                y: 0,
                width: Number.NaN,
                height: 100,
            },
            cropBox: null,
            rotation: 0,
        })).toThrow('page geometry box must contain finite coordinates');
    });
});
