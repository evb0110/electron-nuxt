import { rgbToHex } from '@app/utils/pdf-viewer/text-markup-color/rgbToHex';
import { toOpaqueHighlightDisplayRgbColor } from '@app/utils/pdf-viewer/text-markup-color/toOpaqueHighlightDisplayRgbColor';

export function toOpaqueHighlightDisplayColor(
    color: string,
    opacity: number,
) {
    const displayColor = toOpaqueHighlightDisplayRgbColor(color, opacity);
    return displayColor ? rgbToHex(displayColor) : color;
}
