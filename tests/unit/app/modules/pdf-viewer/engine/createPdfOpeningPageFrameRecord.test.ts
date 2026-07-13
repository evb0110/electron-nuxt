import {
    describe,
    expect,
    it,
} from 'vitest';
import { createPdfOpeningPageFrameRecord } from '@app/modules/pdf-viewer/engine/pdf-initial-surface-placeholder/createPdfOpeningPageFrameRecord';

describe('createPdfOpeningPageFrameRecord', () => {
    it('freezes exact restored-page geometry for the whole open generation', () => {
        const sourceStyle = {
            width: '2137.5px',
            height: '3420px',
            aspectRatio: '2137.5 / 3420',
        };
        const record = createPdfOpeningPageFrameRecord({
            generation: 18,
            pageNumber: 7,
            zoom: 3.5,
            zoomMode: 'custom',
            style: sourceStyle,
        });

        sourceStyle.width = '612px';
        expect(record).toEqual({
            generation: 18,
            pageNumber: 7,
            zoom: 3.5,
            zoomMode: 'custom',
            style: {
                width: '2137.5px',
                height: '3420px',
                aspectRatio: '2137.5 / 3420',
            },
        });
        expect(Object.isFrozen(record)).toBe(true);
        expect(Object.isFrozen(record.style)).toBe(true);
    });
});
