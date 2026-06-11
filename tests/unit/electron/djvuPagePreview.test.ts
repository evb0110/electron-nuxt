import {
    describe,
    expect,
    it,
} from 'vitest';
import { parseDjvuPageSizeOutput } from '@electron/features/djvu/main/pagePreview';

describe('DjVu native page preview helpers', () => {
    it('parses djvused page size output variants', () => {
        expect(parseDjvuPageSizeOutput([
            'width=640 height=480',
            '800x600',
            '1024 768',
            'not a size',
        ].join('\n'), 300)).toEqual([
            {
                width: 640,
                height: 480,
                dpi: 300,
            },
            {
                width: 800,
                height: 600,
                dpi: 300,
            },
            {
                width: 1024,
                height: 768,
                dpi: 300,
            },
        ]);
    });
});
