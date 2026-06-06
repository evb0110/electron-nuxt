import { clamp } from 'es-toolkit/math';
import { clampRgbChannel } from '@app/utils/pdf-viewer/text-markup-color/clampRgbChannel';
import type { IRgbColor } from '@app/utils/pdf-viewer/text-markup-color/textMarkupColorTypes';

export function blendRgbAgainstWhite(color: IRgbColor, opacity: number): IRgbColor {
    const normalizedOpacity = clamp(opacity, 0, 1);
    const white = 255 * (1 - normalizedOpacity);
    return {
        r: clampRgbChannel(color.r * normalizedOpacity + white),
        g: clampRgbChannel(color.g * normalizedOpacity + white),
        b: clampRgbChannel(color.b * normalizedOpacity + white),
    };
}
