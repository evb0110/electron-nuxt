import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    decodeTypedStagedArtifact,
    isTypedStagedArtifact,
} from '@contracts/stagedArtifacts';

const SHA256 = 'a'.repeat(64);

function createArtifact() {
    return {
        receiptVersion: 1 as const,
        artifactKind: 'pdf' as const,
        path: '/tmp/staged.pdf',
        size: 512,
        sha256: SHA256,
        fileIdentity: {
            platform: 'posix' as const,
            deviceId: '16777234',
            inode: '918273645',
        },
        validations: {
            qpdfCheck: true,
            tailCheck: true,
            semanticCheck: true,
            fsynced: false,
            qpdfResult: {
                isValid: true,
                tool: 'qpdf' as const,
                errors: [],
                warnings: ['object stream warning'],
            },
            semanticScopeSha256: 'b'.repeat(64),
            changedObjectRefsSha256: 'c'.repeat(64),
        },
        leaseId: 'lease-1',
        revision: null,
    };
}

describe('typed staged artifact contracts', () => {
    it('decodes POSIX identity and preserves validation evidence', () => {
        const artifact = createArtifact();

        expect(isTypedStagedArtifact(artifact)).toBe(true);
        expect(decodeTypedStagedArtifact(artifact)).toEqual(artifact);
        expect(decodeTypedStagedArtifact(artifact)?.validations.qpdfResult?.warnings)
            .toEqual(['object stream warning']);
    });

    it('accepts Windows identity with conservative validations', () => {
        const artifact = {
            ...createArtifact(),
            fileIdentity: {
                platform: 'win32',
                volumeId: 'volume-1',
                fileId: 'file-1',
            },
            validations: {
                qpdfCheck: false,
                tailCheck: false,
                semanticCheck: false,
                fsynced: false,
            },
        };

        expect(decodeTypedStagedArtifact(artifact)).toEqual(artifact);
    });

    it.each([
        {receiptVersion: 2},
        {artifactKind: 'binary'},
        {size: -1},
        {sha256: 'not-a-digest'},
        {leaseId: ''},
        {revision: ' '},
        {fileIdentity: {
            platform: 'posix',
            deviceId: '-1',
            inode: '2',
        }},
        {fileIdentity: {
            platform: 'win32',
            volumeId: '',
            fileId: '2',
        }},
        {validations: {
            qpdfCheck: true,
            tailCheck: false,
            semanticCheck: false,
            fsynced: false,
        }},
        {validations: {
            qpdfCheck: false,
            tailCheck: false,
            semanticCheck: true,
            fsynced: false,
        }},
        {validations: {
            qpdfCheck: false,
            tailCheck: false,
            semanticCheck: false,
            fsynced: false,
            changedObjectRefsSha256: 'invalid',
        }},
        {validations: {
            qpdfCheck: true,
            tailCheck: false,
            semanticCheck: false,
            fsynced: false,
            qpdfResult: {
                isValid: true,
                tool: 'native',
                errors: [],
                warnings: [],
            },
        }},
        {validations: {
            qpdfCheck: true,
            tailCheck: false,
            semanticCheck: false,
            fsynced: false,
            qpdfResult: {
                isValid: false,
                tool: 'qpdf',
                errors: ['damaged'],
                warnings: [],
            },
        }},
    ])('rejects malformed receipt input %#', (override) => {
        expect(decodeTypedStagedArtifact({
            ...createArtifact(),
            ...override,
        })).toBeNull();
        expect(isTypedStagedArtifact({
            ...createArtifact(),
            ...override,
        })).toBe(false);
    });
});
