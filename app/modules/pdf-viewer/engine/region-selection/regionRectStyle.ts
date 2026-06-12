import type { CSSProperties } from 'vue';
import type { ILocalRect } from '@app/utils/document-viewer/region-geometry/regionGeometryTypes';

export function regionRectStyle(rect: ILocalRect | null): CSSProperties {
    if (!rect) {
        return {};
    }
    return {
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
    };
}
