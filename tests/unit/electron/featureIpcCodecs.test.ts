import {
    describe,
    expect,
    it,
} from 'vitest';
import { AGENT_CHANNELS } from '@electron/features/agent/contract';
import { AGENT_IPC_CODECS } from '@electron/features/agent/agentIpcCodecs';
import { DJVU_CHANNELS } from '@electron/features/djvu/contract';
import { DJVU_IPC_CODECS } from '@electron/features/djvu/djvuIpcCodecs';
import { DOCUMENTS_CHANNELS } from '@electron/features/documents/contract';
import { DOCUMENTS_IPC_CODECS } from '@electron/features/documents/documentsIpcCodecs';
import { IMAGE_EXPORT_CHANNELS } from '@electron/features/image-export/contract';
import { IMAGE_EXPORT_IPC_CODECS } from '@electron/features/image-export/imageExportIpcCodecs';
import { OCR_CHANNELS } from '@electron/features/ocr/contract';
import { OCR_IPC_CODECS } from '@electron/features/ocr/ocrIpcCodecs';
import { SEARCH_CHANNELS } from '@electron/features/search/contract';
import { SEARCH_IPC_CODECS } from '@electron/features/search/searchIpcCodecs';

function expectExhaustiveMap(
    channels: Record<string, string>,
    codecs: Record<string, unknown>,
    excludedChannels: readonly string[] = [],
) {
    const excluded = new Set(excludedChannels);
    expect(Object.keys(codecs).sort()).toEqual([...new Set(Object.values(channels).filter(channel => !excluded.has(channel)))].sort());
}

describe('feature IPC codec maps', () => {
    it('cover every invoke channel exactly once', () => {
        expectExhaustiveMap(AGENT_CHANNELS, AGENT_IPC_CODECS);
        expectExhaustiveMap(DJVU_CHANNELS, DJVU_IPC_CODECS);
        expectExhaustiveMap(DOCUMENTS_CHANNELS, DOCUMENTS_IPC_CODECS, [DOCUMENTS_CHANNELS.fileSavePdfDataPort]);
        expectExhaustiveMap(IMAGE_EXPORT_CHANNELS, IMAGE_EXPORT_IPC_CODECS);
        expectExhaustiveMap(OCR_CHANNELS, OCR_IPC_CODECS);
        expectExhaustiveMap(SEARCH_CHANNELS, SEARCH_IPC_CODECS);
    });

    it('reject malformed main-process results at each feature boundary', () => {
        expect(() => AGENT_IPC_CODECS[AGENT_CHANNELS.getMcpIntegrationStatus].decodeResult({enabled: 'yes'})).toThrow();
        expect(() => DJVU_IPC_CODECS[DJVU_CHANNELS.getInfo].decodeResult({pageCount: 'one'})).toThrow();
        expect(() => DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.fileRead].decodeResult('bytes')).toThrow();
        expect(() => IMAGE_EXPORT_IPC_CODECS[IMAGE_EXPORT_CHANNELS.exportImages].decodeResult({success: 'yes'})).toThrow();
        expect(() => OCR_IPC_CODECS[OCR_CHANNELS.recognize].decodeResult({
            pageNumber: 1,
            success: true,
        })).toThrow();
        expect(() => SEARCH_IPC_CODECS[SEARCH_CHANNELS.search].decodeResult({
            results: [{}],
            truncated: false,
        })).toThrow();
    });

    it('reject malformed renderer arguments before handler dispatch', () => {
        expect(() => AGENT_IPC_CODECS[AGENT_CHANNELS.setMcpIntegrationEnabled].decodeArgs(['yes'])).toThrow();
        expect(() => DJVU_IPC_CODECS[DJVU_CHANNELS.getInfo].decodeArgs([''])).toThrow();
        expect(() => DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.fileReadRange].decodeArgs([
            '/tmp/a.pdf',
            -1,
            4,
        ])).toThrow();
        expect(() => IMAGE_EXPORT_IPC_CODECS[IMAGE_EXPORT_CHANNELS.exportImages].decodeArgs([
            '/tmp/a.pdf',
            [0],
        ])).toThrow();
        expect(() => OCR_IPC_CODECS[OCR_CHANNELS.recognize].decodeArgs([{pageNumber: 0}])).toThrow();
        expect(() => SEARCH_IPC_CODECS[SEARCH_CHANNELS.search].decodeArgs([null])).toThrow();
    });

    it('rejects oversized renderer collections before handler dispatch', () => {
        expect(() => AGENT_IPC_CODECS[AGENT_CHANNELS.sendAssistantMessage].decodeArgs([{
            text: 'inspect',
            attachments: Array.from({length: 65}, () => ({})),
        }])).toThrow('assistant attachments exceeds maximum item count (64)');

        expect(() => DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.allowRendererFileOpenBatch].decodeArgs(
            [Array.from({length: 4_097}, () => ({}))],
        )).toThrow('requests exceeds maximum item count (4096)');

        expect(() => DJVU_IPC_CODECS[DJVU_CHANNELS.printDjvuPath].decodeArgs([
            '/tmp/a.djvu',
            {
                orientation: 'auto',
                pageNumbers: Array.from({length: 100_001}, (_, index) => index + 1),
                viewMode: 'single',
            },
        ])).toThrow('pageNumbers exceeds maximum item count (100000)');

        expect(() => OCR_IPC_CODECS[OCR_CHANNELS.recognizeBatch].decodeArgs([
            Array.from({length: 100_001}),
            'request-1',
        ])).toThrow('OCR pages exceeds maximum item count (100000)');
        expect(() => OCR_IPC_CODECS[OCR_CHANNELS.createSearchablePdf].decodeArgs([
            '/tmp/a.pdf',
            Array.from({length: 100_001}),
            'request-1',
        ])).toThrow('OCR searchable PDF pages exceeds maximum item count (100000)');
    });
});
