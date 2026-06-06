import type { TMarkupSubtype } from '@app/types/annotations';
import { pdfTextMarkupNativeAppearance } from '@app/utils/pdf-viewer/text-markup-visual-model/pdfTextMarkupNativeAppearance';

export function getNativeTextMarkupStrokeWidth(subtype: TMarkupSubtype) {
    if (subtype === 'Highlight') {
        return 0;
    }
    if (subtype === 'Underline') {
        return pdfTextMarkupNativeAppearance.underlineStrokeWidth;
    }
    if (subtype === 'Squiggly') {
        return pdfTextMarkupNativeAppearance.squigglyStrokeWidth;
    }
    return pdfTextMarkupNativeAppearance.strikeOutStrokeWidth;
}
