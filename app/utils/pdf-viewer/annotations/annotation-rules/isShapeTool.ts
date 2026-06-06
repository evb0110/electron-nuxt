import type { TAnnotationTool } from '@app/types/annotations';

export function isShapeTool(tool: TAnnotationTool): tool is Extract<TAnnotationTool, 'draw' | 'rectangle' | 'circle' | 'line' | 'arrow'> {
    return tool === 'draw' || tool === 'rectangle' || tool === 'circle' || tool === 'line' || tool === 'arrow';
}
