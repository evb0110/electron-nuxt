import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    decodeDocumentSaveUtilityRequest,
    decodeDocumentSaveUtilityResult,
} from '@electron/features/documents/main/documentSaveUtilityProtocol';

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
});
