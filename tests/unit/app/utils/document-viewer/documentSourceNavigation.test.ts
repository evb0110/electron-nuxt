import {
    describe,
    expect,
    it,
} from 'vitest';
import {flattenDocumentOutline} from '@app/utils/document-viewer/providers/flattenDocumentOutline';

describe('document source navigation providers', () => {
    it('flattens nested source outlines without losing navigation destinations', () => {
        expect(flattenDocumentOutline([{
            title: 'Part',
            pageNumber: 1,
            children: [{
                title: 'Chapter',
                pageNumber: 2,
                children: [],
            }],
        }])).toEqual([
            {
                title: 'Part',
                pageNumber: 1,
                depth: 0,
            },
            {
                title: 'Chapter',
                pageNumber: 2,
                depth: 1,
            },
        ]);
    });
});
