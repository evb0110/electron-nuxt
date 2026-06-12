import { rgbToHex } from '@app/modules/pdf-viewer/engine/text-markup-color/rgbToHex';
import { toOpaqueHighlightDisplayRgbColor } from '@app/modules/pdf-viewer/engine/text-markup-color/toOpaqueHighlightDisplayRgbColor';

export function toOpaqueHighlightDisplayColor(
    color: string,
    opacity: number,
) {
    const displayColor = toOpaqueHighlightDisplayRgbColor(color, opacity);
    return displayColor ? rgbToHex(displayColor) : color;
}
