import type {
    TAnnotationTool,
    TMarkupSubtype,
} from '@app/types/annotations';

export const toolToMarkupSubtype: Partial<Record<TAnnotationTool, TMarkupSubtype>> = {
    underline: 'Underline',
    strikethrough: 'StrikeOut',
    squiggly: 'Squiggly',
};
