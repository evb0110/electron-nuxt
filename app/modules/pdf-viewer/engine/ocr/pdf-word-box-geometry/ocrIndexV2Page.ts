import type { IOcrWord } from '@app/types/pdf';

export interface IOcrIndexV2Page {
    pageNumber: number;
    rotation: 0 | 90 | 180 | 270;
    render: {
        dpi: number;
        imagePx: {
            w: number;
            h: number;
        };
    };
    text: string;
    words: IOcrWord[];
}
