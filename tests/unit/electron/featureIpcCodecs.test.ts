import {
    describe,
    expect,
    it,
} from 'vitest';
import { AGENT_PLATFORM_FEATURE } from '@contracts/agentPlatformFeature';
import { DJVU_PLATFORM_FEATURE } from '@contracts/djvuPlatformFeature';
import {
    DOCUMENT_MENU_PLATFORM_FEATURE,
    DOCUMENT_PICKER_PLATFORM_FEATURE,
    DOCUMENT_RECENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_WINDOW_PLATFORM_FEATURE,
} from '@contracts/documentsPlatformFeature';
import { DOCUMENTS_CHANNELS } from '@electron/features/documents/contract';
import { DOCUMENTS_IPC_CODECS } from '@electron/features/documents/documentsIpcCodecs';
import { IMAGE_EXPORT_PLATFORM_FEATURE } from '@contracts/imageExportPlatformFeature';
import {
    OCR_PLATFORM_FEATURE,
    OCR_PREPROCESSING_PLATFORM_FEATURE,
} from '@contracts/ocrPlatformFeature';
import { PAGE_OPS_PLATFORM_FEATURE } from '@contracts/pageOpsPlatformFeature';
import { SEARCH_PLATFORM_FEATURE } from '@contracts/searchPlatformFeature';
import { HOST_PLATFORM_FEATURE } from '@contracts/hostPlatformFeature';
import { UPDATES_PLATFORM_FEATURE } from '@contracts/updatesPlatformFeature';
import { WINDOW_TABS_PLATFORM_FEATURE } from '@contracts/windowTabsPlatformFeature';

const IMAGE_EXPORT_CHANNELS = IMAGE_EXPORT_PLATFORM_FEATURE.invokeChannels;
const AGENT_CHANNELS = AGENT_PLATFORM_FEATURE.invokeChannels;
const AGENT_IPC_CODECS = AGENT_PLATFORM_FEATURE.ipcCodecs;
const IMAGE_EXPORT_IPC_CODECS = IMAGE_EXPORT_PLATFORM_FEATURE.ipcCodecs;
const PAGE_OPS_CHANNELS = PAGE_OPS_PLATFORM_FEATURE.invokeChannels;
const PAGE_OPS_IPC_CODECS = PAGE_OPS_PLATFORM_FEATURE.ipcCodecs;
const SEARCH_CHANNELS = SEARCH_PLATFORM_FEATURE.invokeChannels;
const SEARCH_IPC_CODECS = SEARCH_PLATFORM_FEATURE.ipcCodecs;
const HOST_CHANNELS = HOST_PLATFORM_FEATURE.invokeChannels;
const HOST_IPC_CODECS = HOST_PLATFORM_FEATURE.ipcCodecs;
const UPDATES_CHANNELS = UPDATES_PLATFORM_FEATURE.invokeChannels;
const UPDATES_IPC_CODECS = UPDATES_PLATFORM_FEATURE.ipcCodecs;
const WINDOW_TABS_CHANNELS = WINDOW_TABS_PLATFORM_FEATURE.invokeChannels;
const WINDOW_TABS_IPC_CODECS = WINDOW_TABS_PLATFORM_FEATURE.ipcCodecs;
const DJVU_CHANNELS = DJVU_PLATFORM_FEATURE.invokeChannels;
const DJVU_IPC_CODECS = DJVU_PLATFORM_FEATURE.ipcCodecs;
const OCR_CHANNELS = {
    ...OCR_PLATFORM_FEATURE.invokeChannels,
    preprocessingValidate: OCR_PREPROCESSING_PLATFORM_FEATURE.invokeChannels.validate,
    preprocessingPreprocessPage:
        OCR_PREPROCESSING_PLATFORM_FEATURE.invokeChannels.preprocessPage,
};
const OCR_IPC_CODECS = {
    ...OCR_PLATFORM_FEATURE.ipcCodecs,
    ...OCR_PREPROCESSING_PLATFORM_FEATURE.ipcCodecs,
};
const djvuCodec = (channel: string) => DJVU_IPC_CODECS[channel]!;
const agentCodec = (channel: string) => AGENT_IPC_CODECS[channel]!;
const ocrCodec = (channel: string) => OCR_IPC_CODECS[channel]!;
const validStagedArtifact = {
    receiptVersion: 1 as const,
    artifactKind: 'pdf' as const,
    path: '/tmp/staged.pdf',
    size: 512,
    sha256: 'a'.repeat(64),
    fileIdentity: {
        platform: 'posix' as const,
        deviceId: '1',
        inode: '2',
    },
    validations: {
        qpdfCheck: false,
        tailCheck: false,
        semanticCheck: false,
        fsynced: false,
    },
    leaseId: 'lease-1',
    revision: null,
};

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
        expectExhaustiveMap(
            DOCUMENT_PICKER_PLATFORM_FEATURE.invokeChannels,
            DOCUMENT_PICKER_PLATFORM_FEATURE.ipcCodecs,
        );
        expectExhaustiveMap(
            DOCUMENT_RECENT_FILES_PLATFORM_FEATURE.invokeChannels,
            DOCUMENT_RECENT_FILES_PLATFORM_FEATURE.ipcCodecs,
        );
        expectExhaustiveMap(
            DOCUMENT_WINDOW_PLATFORM_FEATURE.invokeChannels,
            DOCUMENT_WINDOW_PLATFORM_FEATURE.ipcCodecs,
        );
        expectExhaustiveMap(
            DOCUMENT_MENU_PLATFORM_FEATURE.invokeChannels,
            DOCUMENT_MENU_PLATFORM_FEATURE.ipcCodecs,
        );
        expectExhaustiveMap(IMAGE_EXPORT_CHANNELS, IMAGE_EXPORT_IPC_CODECS);
        expectExhaustiveMap(OCR_CHANNELS, OCR_IPC_CODECS);
        expectExhaustiveMap(PAGE_OPS_CHANNELS, PAGE_OPS_IPC_CODECS);
        expectExhaustiveMap(SEARCH_CHANNELS, SEARCH_IPC_CODECS);
        expectExhaustiveMap(HOST_CHANNELS, HOST_IPC_CODECS);
        expectExhaustiveMap(UPDATES_CHANNELS, UPDATES_IPC_CODECS);
        expectExhaustiveMap(WINDOW_TABS_CHANNELS, WINDOW_TABS_IPC_CODECS);
    });

    it('reject malformed main-process results at each feature boundary', () => {
        expect(() => agentCodec(AGENT_CHANNELS.getMcpIntegrationStatus).decodeResult({enabled: 'yes'})).toThrow();
        expect(() => djvuCodec(DJVU_CHANNELS.getInfo).decodeResult({pageCount: 'one'})).toThrow();
        expect(() => DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.fileRead].decodeResult('bytes')).toThrow();
        expect(() => DOCUMENT_PICKER_PLATFORM_FEATURE.ipcCodecs[
            DOCUMENT_PICKER_PLATFORM_FEATURE.invokeChannels.openDocumentDialog
        ]!.decodeResult({kind: 'pdf'})).toThrow();
        expect(() => IMAGE_EXPORT_IPC_CODECS[IMAGE_EXPORT_CHANNELS.exportPdfToImages]!.decodeResult({success: 'yes'})).toThrow();
        expect(() => ocrCodec(OCR_CHANNELS.recognize).decodeResult({
            pageNumber: 1,
            success: true,
        })).toThrow();
        expect(() => PAGE_OPS_IPC_CODECS[PAGE_OPS_CHANNELS.rotate]!.decodeResult({success: 'yes'})).toThrow();
        expect(() => SEARCH_IPC_CODECS[SEARCH_CHANNELS.run]!.decodeResult({
            results: [{}],
            truncated: false,
        })).toThrow();
        expect(() => HOST_IPC_CODECS[HOST_CHANNELS.getEnvironment]!.decodeResult({
            platform: 'freebsd',
            osScaleFactor: 1,
        })).toThrow();
        expect(() => UPDATES_IPC_CODECS[UPDATES_CHANNELS.getState]!.decodeResult({phase: 'future'})).toThrow();
        expect(() => WINDOW_TABS_IPC_CODECS[WINDOW_TABS_CHANNELS.transferAck]!.decodeArgs([{
            transferId: '',
            success: true,
        }])).toThrow();
    });

    it('retains intentional documents channel aliases', () => {
        expect(DOCUMENT_PICKER_PLATFORM_FEATURE.invokeChannels.openPdfDialog)
            .toBe(DOCUMENT_PICKER_PLATFORM_FEATURE.invokeChannels.openDocumentDialog);
        expect(DOCUMENT_PICKER_PLATFORM_FEATURE.methods.openPdfDialog.aliasOf)
            .toBe('openDocumentDialog');
        expect(DOCUMENT_MENU_PLATFORM_FEATURE.eventChannels.onOpenPdfDirectBatchProgress)
            .toBe(DOCUMENT_MENU_PLATFORM_FEATURE.eventChannels.onOpenDocumentDirectBatchProgress);
        expect(DOCUMENT_MENU_PLATFORM_FEATURE.events.onOpenPdfDirectBatchProgress.aliasOf)
            .toBe('onOpenDocumentDirectBatchProgress');
    });

    it('preserves the source identity needed to validate cached opening geometry', () => {
        expect(DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.fileStat].decodeResult({
            size: 28_000_000,
            modifiedAt: 1_720_000_000_000,
        })).toEqual({
            size: 28_000_000,
            modifiedAt: 1_720_000_000_000,
        });
        expect(() => DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.fileStat].decodeResult({
            size: 28_000_000,
            modifiedAt: -1,
        })).toThrow('invalid file modification time');
        expect(djvuCodec(DJVU_CHANNELS.getPageSourceInfo).decodeResult({
            pageCount: 431,
            pageNumber: 1,
            pageSize: {
                width: 600,
                height: 800,
                dpi: 300,
            },
            sourceSize: 28_000_000,
            sourceModifiedAt: 1_720_000_000_000,
        })).toEqual({
            pageCount: 431,
            pageNumber: 1,
            pageSize: {
                width: 600,
                height: 800,
                dpi: 300,
            },
            sourceSize: 28_000_000,
            sourceModifiedAt: 1_720_000_000_000,
        });
        expect(djvuCodec(DJVU_CHANNELS.awaitOpenJob).decodeResult({
            success: true,
            pageCount: 431,
            pageSourceInfo: {
                pageCount: 431,
                pageNumber: 1,
                pageSize: {
                    width: 600,
                    height: 800,
                    dpi: 300,
                },
                sourceSize: 28_000_000,
                sourceModifiedAt: 1_720_000_000_000,
            },
        })).toMatchObject({
            success: true,
            pageSourceInfo: {
                sourceSize: 28_000_000,
                sourceModifiedAt: 1_720_000_000_000,
            },
        });
    });

    it('validates streamed DjVu text-search options and word geometry', () => {
        expect(djvuCodec(DJVU_CHANNELS.searchText).decodeArgs([
            '/tmp/book.djvu',
            'needle',
            {
                requestId: 'djvu-search-1',
                pageCount: 431,
                matchCase: false,
                wholeWord: true,
                useRegex: false,
            },
        ])).toEqual([
            '/tmp/book.djvu',
            'needle',
            {
                requestId: 'djvu-search-1',
                pageCount: 431,
                matchCase: false,
                wholeWord: true,
                useRegex: false,
            },
        ]);
        expect(djvuCodec(DJVU_CHANNELS.searchText).decodeResult({
            truncated: false,
            results: [{
                pageNumber: 9,
                pageMatchIndex: 0,
                matchIndex: 0,
                startOffset: 5,
                endOffset: 11,
                excerpt: {
                    prefix: false,
                    suffix: false,
                    before: '',
                    match: 'needle',
                    after: '',
                },
                pageWidth: 1000,
                pageHeight: 2000,
                rotation: 0,
                words: [{
                    text: 'needle',
                    x: 150,
                    y: 400,
                    width: 200,
                    height: 100,
                }],
            }],
        })).toMatchObject({results: [{
            pageNumber: 9,
            words: [{y: 400}],
        }]});
        expect(() => djvuCodec(DJVU_CHANNELS.searchText).decodeArgs([
            '/tmp/book.djvu',
            'needle',
            {
                requestId: 'djvu-search-1',
                pageCount: 20_001,
            },
        ])).toThrow('valid requestId and pageCount');
        expect(() => djvuCodec(DJVU_CHANNELS.searchText).decodeResult({
            truncated: false,
            results: [{
                pageNumber: 9,
                words: [{width: -1}],
            }],
        })).toThrow('invalid');
    });

    it('validates exact first-page opening geometry at the IPC boundary', () => {
        const validGeometry = {
            pageNumber: 1,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 90,
            size: 28_000_000,
            modifiedAt: 1_720_000_000_000,
        };
        expect(DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.pdfOpeningGeometry].decodeResult(validGeometry))
            .toEqual(validGeometry);
        expect(DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.openDocumentDirect].decodeResult({
            kind: 'pdf',
            workingPath: '/managed/scan.pdf',
            originalPath: '/documents/scan.pdf',
            openingGeometry: validGeometry,
        })).toEqual({
            kind: 'pdf',
            workingPath: '/managed/scan.pdf',
            originalPath: '/documents/scan.pdf',
            openingGeometry: validGeometry,
        });
        expect(() => DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.pdfOpeningGeometry].decodeResult({
            ...validGeometry,
            pageNumber: 2,
        })).toThrow('invalid PDF opening geometry result');
        expect(() => DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.pdfOpeningGeometry].decodeResult({
            ...validGeometry,
            rotation: 45,
        })).toThrow('invalid PDF opening geometry result');
        expect(() => DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.openDocumentDirect].decodeResult({
            kind: 'pdf',
            workingPath: '/managed/scan.pdf',
            originalPath: '/documents/scan.pdf',
            openingGeometry: {
                ...validGeometry,
                rotation: 45,
            },
        })).toThrow('invalid PDF opening geometry result');
    });

    it.each([
        'djvu-convert',
        'djvu-open',
        'djvu-print',
    ] as const)('decodes %s document-output job state', (operation) => {
        expect(djvuCodec(DJVU_CHANNELS.subscribeJob).decodeResult({
            jobId: `${operation}-job`,
            operation,
            status: 'queued',
            progress: {
                jobId: `${operation}-job`,
                phase: operation === 'djvu-open' ? 'loading' : 'converting',
                percent: 0,
            },
            updatedAtMs: 1,
        })).toMatchObject({
            operation,
            status: 'queued',
        });
    });

    it('reject malformed renderer arguments before handler dispatch', () => {
        expect(() => agentCodec(AGENT_CHANNELS.setMcpIntegrationEnabled).decodeArgs(['yes'])).toThrow();
        expect(() => djvuCodec(DJVU_CHANNELS.getInfo).decodeArgs([''])).toThrow();
        expect(() => DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.fileReadRange].decodeArgs([
            '/tmp/a.pdf',
            -1,
            4,
        ])).toThrow();
        expect(() => IMAGE_EXPORT_IPC_CODECS[IMAGE_EXPORT_CHANNELS.exportPdfToImages]!.decodeArgs([
            '/tmp/a.pdf',
            [0],
        ])).toThrow();
        expect(() => PAGE_OPS_IPC_CODECS[PAGE_OPS_CHANNELS.rotate]!.decodeArgs([
            '/tmp/a.pdf',
            [1],
            1,
            45,
            undefined,
        ])).toThrow();
        expect(() => ocrCodec(OCR_CHANNELS.recognize).decodeArgs([{pageNumber: 0}])).toThrow();
        expect(() => ocrCodec(OCR_CHANNELS.resolveDocumentOcrPage).decodeArgs([
            '/tmp/a.pdf',
            'drt1:test',
            0,
        ])).toThrow();
        expect(() => SEARCH_IPC_CODECS[SEARCH_CHANNELS.run]!.decodeArgs([null])).toThrow();
    });

    it('decodes staged artifact receipts in both native IPC directions', () => {
        expect(DOCUMENTS_IPC_CODECS[
            DOCUMENTS_CHANNELS.fileApplyPdfNativeMutationsToWorkingCopy
        ].decodeResult({
            applied: true,
            validation: {
                isValid: true,
                tool: 'native',
                errors: [],
                warnings: [],
            },
            stagedOutput: validStagedArtifact,
        })).toMatchObject({stagedOutput: validStagedArtifact});
        expect(DOCUMENTS_IPC_CODECS[
            DOCUMENTS_CHANNELS.fileCommitStagedPdfNativeMutations
        ].decodeArgs([
            '/tmp/working.pdf',
            validStagedArtifact,
        ])).toEqual([
            '/tmp/working.pdf',
            validStagedArtifact,
        ]);
    });

    it('rejects malformed staged artifact receipts at the IPC boundary', () => {
        const malformedArtifact = {
            ...validStagedArtifact,
            validations: {
                ...validStagedArtifact.validations,
                qpdfCheck: true,
            },
        };

        expect(() => DOCUMENTS_IPC_CODECS[
            DOCUMENTS_CHANNELS.fileApplyPdfNativeMutationsToWorkingCopy
        ].decodeResult({
            applied: true,
            validation: null,
            stagedOutput: malformedArtifact,
        })).toThrow('invalid staged native PDF output');
        expect(() => DOCUMENTS_IPC_CODECS[
            DOCUMENTS_CHANNELS.fileCommitStagedPdfNativeMutations
        ].decodeArgs([
            '/tmp/working.pdf',
            malformedArtifact,
        ])).toThrow('typed staged artifact');
    });

    it('rejects oversized renderer collections before handler dispatch', () => {
        expect(() => agentCodec(AGENT_CHANNELS.sendAssistantMessage).decodeArgs([{
            text: 'inspect',
            attachments: Array.from({length: 9}, () => ({})),
        }])).toThrow('assistant attachments exceeds maximum item count (8)');

        expect(() => DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.allowRendererFileOpenBatch].decodeArgs(
            [Array.from({length: 4_097}, () => ({}))],
        )).toThrow('requests exceeds maximum item count (4096)');

        expect(() => djvuCodec(DJVU_CHANNELS.printDjvuPath).decodeArgs([
            '/tmp/a.djvu',
            {
                orientation: 'auto',
                pageNumbers: Array.from({length: 100_001}, (_, index) => index + 1),
                viewMode: 'single',
            },
        ])).toThrow('pageNumbers exceeds maximum item count (100000)');

        expect(() => ocrCodec(OCR_CHANNELS.recognizeBatch).decodeArgs([
            Array.from({length: 100_001}),
            'request-1',
        ])).toThrow('OCR pages exceeds maximum item count (100000)');
        expect(() => ocrCodec(OCR_CHANNELS.createSearchablePdf).decodeArgs([
            '/tmp/a.pdf',
            Array.from({length: 100_001}),
            'request-1',
        ])).toThrow('OCR searchable PDF pages exceeds maximum item count (100000)');
    });
});
