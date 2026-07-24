import {
    describe,
    expect,
    it,
} from 'vitest';
import { AGENT_PLATFORM_FEATURE } from '@contracts/agentPlatformFeature';
import { DJVU_PLATFORM_FEATURE } from '@contracts/djvuPlatformFeature';
import { PLATFORM_FEATURE_REGISTRY } from '@contracts/platformApiDescriptor';
import { DOCUMENTS_CHANNELS } from '@electron/features/documents/contract';
import { DOCUMENTS_IPC_CODECS } from '@electron/features/documents/documentsIpcCodecs';
import {
    OCR_PLATFORM_FEATURE,
    OCR_PREPROCESSING_PLATFORM_FEATURE,
} from '@contracts/ocrPlatformFeature';

const AGENT_CHANNELS = AGENT_PLATFORM_FEATURE.invokeChannels;
const AGENT_IPC_CODECS = AGENT_PLATFORM_FEATURE.ipcCodecs;
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
        for (const feature of PLATFORM_FEATURE_REGISTRY) {
            expectExhaustiveMap(feature.invokeChannels, feature.ipcCodecs);
        }
        expectExhaustiveMap(DOCUMENTS_CHANNELS, DOCUMENTS_IPC_CODECS, [DOCUMENTS_CHANNELS.fileSavePdfDataPort]);
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
