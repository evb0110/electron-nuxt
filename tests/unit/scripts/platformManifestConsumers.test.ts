import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    AGGREGATE_DOCUMENTS_ALLOWED_FILES,
    AGGREGATE_DOCUMENTS_UNAPPROVED_BASELINE,
    collectAggregateDocumentsCallSites,
    isAggregateDocumentsBaselineSatisfied,
} from '@scripts/reportPlatformManifestConsumers';
import { PLATFORM_API_DESCRIPTOR } from '@contracts/platformApiDescriptor';
import { platformMethodManifest } from '@contracts/platformMethodManifest';

describe('platform manifest consumer boundary', () => {
    it('uses the canonical platform descriptor method inventory without a second list', () => {
        expect(platformMethodManifest).toBe(PLATFORM_API_DESCRIPTOR.methods);
        expect(platformMethodManifest.map(descriptor => descriptor.path.join('.'))).toEqual(
            PLATFORM_API_DESCRIPTOR.methods.map(descriptor => descriptor.path.join('.')),
        );
    });

    it('keeps a strict zero baseline for unapproved aggregate documents access', () => {
        expect(AGGREGATE_DOCUMENTS_UNAPPROVED_BASELINE).toBe(0);
        expect(isAggregateDocumentsBaselineSatisfied(0)).toBe(true);
        expect(isAggregateDocumentsBaselineSatisfied(1)).toBe(false);
        expect(collectAggregateDocumentsCallSites(
            'app/modules/workspace-shell/useDocuments.ts',
            'const documents = platform.documents;\n',
        )).toEqual(['app/modules/workspace-shell/useDocuments.ts:1:19']);
    });

    it('preserves explicit aggregate access at platform composition boundaries', () => {
        for (const file of AGGREGATE_DOCUMENTS_ALLOWED_FILES) {
            expect(collectAggregateDocumentsCallSites(
                file,
                'const documents = platform.documents;\n',
            )).toEqual([]);
        }
    });

    it('does not treat narrow document capabilities as aggregate access', () => {
        expect(collectAggregateDocumentsCallSites(
            'app/modules/workspace-shell/useDocuments.ts',
            'const files = platform.documentFiles;\n',
        )).toEqual([]);
    });
});
