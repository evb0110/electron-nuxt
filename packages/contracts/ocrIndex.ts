import type { IOcrWord } from '@contracts/shared';

export type TOcrIndexRotation = 0 | 90 | 180 | 270;

export interface IOcrIndexV2Manifest {
    version: 2;
    createdAt: number;
    source: { pdfPath: string };
    pageCount: number;
    pageBox: 'crop';
    ocr: {
        engine: 'tesseract';
        languages: string[];
        renderDpi: number;
    };
    pages: Record<number, { path: string }>;
}

export interface IOcrIndexV2Page {
    pageNumber: number;
    rotation: TOcrIndexRotation;
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
