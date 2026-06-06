import { blendRgbAgainstWhite } from '@app/utils/pdf-viewer/text-markup-color/blendRgbAgainstWhite';
import { parseCssRgbColor } from '@app/utils/pdf-viewer/text-markup-color/parseCssRgbColor';

export function toOpaqueHighlightDisplayRgbColor(
    color: string | null | undefined,
    opacity: number,
) {
    const parsed = parseCssRgbColor(color);
    if (!parsed) {
        return null;
    }
    return blendRgbAgainstWhite(parsed, opacity);
}
