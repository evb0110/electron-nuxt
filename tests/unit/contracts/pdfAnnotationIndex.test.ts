import {
    describe,
    expect,
    it,
} from 'vitest';
import {PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES} from '@contracts/electronApiDocuments';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {DOCUMENT_FILES_PLATFORM_FEATURE} from '@contracts/documentsPlatformFeature';

const token = requireDocumentRevisionToken('drt1:annotation-index-test');
const channels = DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels;
const codecs = DOCUMENT_FILES_PLATFORM_FEATURE.ipcCodecs;

describe('PDF annotation index IPC contracts', () => {
    it('round-trips begin, chunk, and lifecycle payloads', () => {
        const entry = {
            pageIndex: 4,
            objectNumber: 17,
            generationNumber: 0,
            subtype: 'Text',
            name: 'note-17',
            popupRef: {
                objectNumber: 18,
                generationNumber: 0,
            },
            parentRef: null,
        };
        const session = {
            sessionId: 'annotation-index-session',
            documentRef: '/tmp/document.pdf',
            documentRevisionToken: token,
            pageCount: 5,
            entryCount: 1,
            totalBytes: 192,
        };
        const chunk = {
            offset: 0,
            nextOffset: null,
            byteLength: 192,
            done: true,
            entries: [entry],
        };

        expect(codecs[channels.beginPdfAnnotationIndex]!.decodeArgs([
            '/tmp/document.pdf',
            {expectedDocumentRevisionToken: token},
        ])).toEqual([
            '/tmp/document.pdf',
            {expectedDocumentRevisionToken: token},
        ]);
        expect(codecs[channels.beginPdfAnnotationIndex]!.decodeResult(session)).toEqual(session);
        expect(codecs[channels.readPdfAnnotationIndexChunk]!.decodeArgs([
            'annotation-index-session',
            0,
            {chunkBytes: 512},
        ])).toEqual([
            'annotation-index-session',
            0,
            {chunkBytes: 512},
        ]);
        expect(codecs[channels.readPdfAnnotationIndexChunk]!.decodeResult(chunk)).toEqual(chunk);
        expect(codecs[channels.readPdfAnnotationIndexChunk]!.decodeResult({
            ...chunk,
            entries: [{
                ...entry,
                objectNumber: 0,
                name: null,
            }],
        }).entries[0]?.objectNumber).toBe(0);
        expect(codecs[channels.releasePdfAnnotationIndex]!.decodeArgs(['annotation-index-session'])).toEqual(['annotation-index-session']);
        expect(codecs[channels.cancelPdfAnnotationIndex]!.decodeResult({canceled: true})).toEqual({canceled: true});
    });

    it('rejects missing revisions, unsafe references, and oversized chunks', () => {
        const beginCodec = codecs[channels.beginPdfAnnotationIndex]!;
        const chunkCodec = codecs[channels.readPdfAnnotationIndexChunk]!;

        expect(() => beginCodec.decodeArgs([
            '/tmp/document.pdf',
            {},
        ])).toThrow(/invalid document revision options/iu);
        expect(() => chunkCodec.decodeArgs([
            'annotation-index-session',
            0,
            {chunkBytes: PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES + 1},
        ])).toThrow(/chunkBytes/iu);
        expect(() => chunkCodec.decodeResult({
            offset: 0,
            nextOffset: null,
            byteLength: 0,
            done: true,
            entries: [{
                pageIndex: 0,
                objectNumber: Number.MAX_SAFE_INTEGER + 1,
                generationNumber: 0,
                subtype: 'Text',
                name: null,
                popupRef: null,
                parentRef: null,
            }],
        })).toThrow(/objectNumber/iu);
        expect(() => chunkCodec.decodeResult({
            offset: 0,
            nextOffset: null,
            byteLength: 0,
            done: true,
            entries: [{
                pageIndex: 0,
                objectNumber: -1,
                generationNumber: 0,
                subtype: 'Text',
                name: null,
                popupRef: null,
                parentRef: null,
            }],
        })).toThrow(/objectNumber/iu);
    });
});
