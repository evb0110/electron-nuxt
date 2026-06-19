export const PDF_PAGE_LABEL_STYLE_VALUES = [
    'D',
    'R',
    'r',
    'A',
    'a',
] as const;

export type TPdfPageLabelStyle = typeof PDF_PAGE_LABEL_STYLE_VALUES[number] | null;

export interface IPdfPageLabelRange {
    startPage: number;
    style: TPdfPageLabelStyle;
    prefix: string;
    startNumber: number;
}

export interface IPdfPageLabelsMutation {
    totalPages: number;
    ranges: IPdfPageLabelRange[];
}
