import type { IOcrWord } from '@contracts/shared';
import type { IDocumentRevisionStamp } from '@contracts/documentRevision';

export type TOcrIndexRotation = 0 | 90 | 180 | 270;

interface IOcrIndexManifestBase {
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

interface IOcrIndexPageBase {
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

export interface IOcrIndexV2Manifest extends IOcrIndexManifestBase { version: 2; }

export interface IOcrIndexV2Page extends IOcrIndexPageBase {}

export interface IOcrIndexV3Manifest extends IOcrIndexManifestBase {
    version: 3;
    documentRevision: IDocumentRevisionStamp;
}

export interface IOcrIndexV3Page extends IOcrIndexPageBase { documentRevision: IDocumentRevisionStamp; }
