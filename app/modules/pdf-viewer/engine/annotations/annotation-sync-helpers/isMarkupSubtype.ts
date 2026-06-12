import type { TMarkupSubtype } from '@app/types/annotations';

export function isMarkupSubtype(value: unknown): value is TMarkupSubtype {
    return (
        value === 'Highlight'
        || value === 'Underline'
        || value === 'StrikeOut'
        || value === 'Squiggly'
    );
}
