import {
    describe,
    expect,
    it,
} from 'vitest';
import { computeSummaryStableKey } from '@app/modules/pdf-viewer/annotations/domain/annotationSummaryIdentity';

describe('computeSummaryStableKey', () => {
    it('prefers durable pdf-side identity before runtime ids', () => {
        expect(computeSummaryStableKey({
            annotationId: '12R',
            annotationName: ' evb-markup:stable ',
            id: 'editor-id',
            pageIndex: 1,
            source: 'editor',
            uid: 'uid-1',
        })).toBe('nm:evb-markup:stable');

        expect(computeSummaryStableKey({
            annotationId: '12R',
            id: 'editor-id',
            pageIndex: 1,
            source: 'editor',
            uid: 'uid-1',
        })).toBe('ann:1:12R');

        expect(computeSummaryStableKey({
            annotationId: null,
            id: 'editor-id',
            pageIndex: 1,
            source: 'editor',
            uid: 'uid-1',
        })).toBe('uid:1:uid-1');

        expect(computeSummaryStableKey({
            annotationId: null,
            id: 'editor-id',
            pageIndex: 1,
            source: 'editor',
            uid: null,
        })).toBe('src:editor:1:editor-id');
    });
});
