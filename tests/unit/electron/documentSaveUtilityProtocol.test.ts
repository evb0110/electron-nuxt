import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createChangedObjectRefsSha256,
    decodeDocumentSaveUtilityRequest,
    decodeDocumentSaveUtilityResult,
    getDocumentSaveUtilityReusePlan,
} from '@electron/features/documents/main/documentSaveUtilityProtocol';

function createStagedArtifact(overrides: {
    changedObjectRefsSha256?: string;
    fsynced?: boolean;
    qpdfCheck?: boolean;
    tailCheck?: boolean;
} = {}) {
    return {
        receiptVersion: 1,
        artifactKind: 'pdf',
        path: '/tmp/output.tmp',
        size: 100,
        sha256: 'a'.repeat(64),
        fileIdentity: process.platform === 'win32'
            ? {
                platform: 'win32',
                volumeId: '1',
                fileId: '2',
            }
            : {
                platform: 'posix',
                deviceId: '1',
                inode: '2',
            },
        validations: {
            qpdfCheck: overrides.qpdfCheck ?? true,
            tailCheck: overrides.tailCheck ?? true,
            semanticCheck: false,
            fsynced: overrides.fsynced ?? true,
            qpdfResult: {
                isValid: true,
                tool: 'qpdf',
                errors: [],
                warnings: ['recoverable qpdf warning'],
            },
            ...(overrides.changedObjectRefsSha256 === undefined
                ? {}
                : {changedObjectRefsSha256: overrides.changedObjectRefsSha256}),
        },
        leaseId: 'lease-1',
        revision: null,
    } as const;
}

describe('document save utility protocol', () => {
    it('accepts a bounded changed-object xref validation set', () => {
        expect(decodeDocumentSaveUtilityRequest({
            type: 'commit',
            sourcePath: '/tmp/output.tmp',
            targetPath: '/tmp/output.pdf',
            expectedBytes: 100,
            changedObjectRefs: [
                '12 0 R',
                '44 2 R',
            ],
        })).toMatchObject({changedObjectRefs: [
            '12 0 R',
            '44 2 R',
        ]});
    });

    it('accepts a sibling absolute staging and target path', () => {
        expect(decodeDocumentSaveUtilityRequest({
            type: 'commit',
            sourcePath: '/tmp/.document.tmp',
            targetPath: '/tmp/document.pdf',
            expectedBytes: 123,
        })).toEqual({
            type: 'commit',
            sourcePath: '/tmp/.document.tmp',
            targetPath: '/tmp/document.pdf',
            expectedBytes: 123,
        });
    });

    it('accepts a bounded inspection request without a target path', () => {
        expect(decodeDocumentSaveUtilityRequest({
            type: 'inspect',
            sourcePath: '/tmp/document.pdf',
            expectedBytes: 123,
        })).toEqual({
            type: 'inspect',
            sourcePath: '/tmp/document.pdf',
            expectedBytes: 123,
        });
        expect(decodeDocumentSaveUtilityRequest({
            type: 'inspect',
            sourcePath: 'document.pdf',
            expectedBytes: 123,
        })).toBeNull();
    });

    it.each([
        {
            sourcePath: 'relative.tmp',
            targetPath: '/tmp/document.pdf',
        },
        {
            sourcePath: '/tmp/document.tmp',
            targetPath: '/other/document.pdf',
        },
        {
            sourcePath: '/tmp/document.pdf',
            targetPath: '/tmp/document.pdf',
        },
    ])('rejects unsafe path pairing: $sourcePath', paths => {
        expect(decodeDocumentSaveUtilityRequest({
            type: 'commit',
            ...paths,
            expectedBytes: 123,
        })).toBeNull();
    });

    it('validates the streamed digest result shape', () => {
        expect(decodeDocumentSaveUtilityResult({
            type: 'result',
            ok: true,
            bytes: 123,
            sha256: 'a'.repeat(64),
        })).toEqual({
            type: 'result',
            ok: true,
            bytes: 123,
            sha256: 'a'.repeat(64),
        });
        expect(decodeDocumentSaveUtilityResult({
            type: 'result',
            ok: true,
            bytes: 123,
            sha256: 'not-a-digest',
        })).toBeNull();
    });

    it('preserves authoritative qpdf warnings in a matching staged receipt', () => {
        const stagedArtifact = createStagedArtifact();

        expect(decodeDocumentSaveUtilityRequest({
            type: 'commit',
            sourcePath: '/tmp/output.tmp',
            targetPath: '/tmp/output.pdf',
            expectedBytes: 100,
            stagedArtifact,
        })).toMatchObject({stagedArtifact: {validations: {qpdfResult: {warnings: ['recoverable qpdf warning']}}}});
    });

    it('rejects staged receipts for another source path or byte size', () => {
        const stagedArtifact = createStagedArtifact();

        expect(decodeDocumentSaveUtilityRequest({
            type: 'commit',
            sourcePath: '/tmp/other.tmp',
            targetPath: '/tmp/output.pdf',
            expectedBytes: 100,
            stagedArtifact,
        })).toBeNull();
        expect(decodeDocumentSaveUtilityRequest({
            type: 'commit',
            sourcePath: '/tmp/output.tmp',
            targetPath: '/tmp/output.pdf',
            expectedBytes: 101,
            stagedArtifact,
        })).toBeNull();
    });

    it('reuses each utility gate only for its exact receipt evidence', () => {
        const changedObjectRefs = [
            '44 2 R',
            '12 0 R',
        ];
        const request = decodeDocumentSaveUtilityRequest({
            type: 'commit',
            sourcePath: '/tmp/output.tmp',
            targetPath: '/tmp/output.pdf',
            expectedBytes: 100,
            changedObjectRefs,
            stagedArtifact: createStagedArtifact({changedObjectRefsSha256: createChangedObjectRefsSha256(changedObjectRefs)}),
        });

        expect(request?.type).toBe('commit');
        if (!request || request.type !== 'commit') {
            throw new Error('Expected a decoded commit request');
        }
        expect(getDocumentSaveUtilityReusePlan(request)).toEqual(
            process.platform === 'win32'
                ? {
                    fingerprint: false,
                    tailCheck: false,
                    qpdfCheck: false,
                    changedObjectRefsCheck: false,
                    fileSync: false,
                }
                : {
                    fingerprint: true,
                    tailCheck: true,
                    qpdfCheck: true,
                    changedObjectRefsCheck: true,
                    fileSync: true,
                },
        );
    });

    it('reruns targeted validation when the changed-object scope differs', () => {
        const request = decodeDocumentSaveUtilityRequest({
            type: 'commit',
            sourcePath: '/tmp/output.tmp',
            targetPath: '/tmp/output.pdf',
            expectedBytes: 100,
            changedObjectRefs: ['12 0 R'],
            stagedArtifact: createStagedArtifact({changedObjectRefsSha256: createChangedObjectRefsSha256(['44 2 R'])}),
        });

        if (!request || request.type !== 'commit') {
            throw new Error('Expected a decoded commit request');
        }
        expect(getDocumentSaveUtilityReusePlan(request).changedObjectRefsCheck).toBe(false);
    });

    it('does not inherit file durability across an unsynced byte-preserving copy', () => {
        const request = decodeDocumentSaveUtilityRequest({
            type: 'commit',
            sourcePath: '/tmp/output.tmp',
            targetPath: '/tmp/output.pdf',
            expectedBytes: 100,
            stagedArtifact: createStagedArtifact({fsynced: false}),
        });

        if (!request || request.type !== 'commit') {
            throw new Error('Expected a decoded commit request');
        }
        expect(getDocumentSaveUtilityReusePlan(request).fileSync).toBe(false);
    });

    it('normalizes changed-object scope before hashing', () => {
        expect(createChangedObjectRefsSha256([
            '44 2 R',
            '12 0 R',
            '44 2 R',
        ])).toBe(createChangedObjectRefsSha256([
            '12 0 R',
            '44 2 R',
        ]));
    });
});
