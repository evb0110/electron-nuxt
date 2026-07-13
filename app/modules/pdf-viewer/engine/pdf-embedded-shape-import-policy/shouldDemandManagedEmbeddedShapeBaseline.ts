import type { TAnnotationTool } from '@app/types/annotations';
import { isSelectionInteractionTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isSelectionInteractionTool';
import { isShapeTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isShapeTool';

export function shouldDemandManagedEmbeddedShapeBaseline(tool: TAnnotationTool) {
    return isShapeTool(tool) || isSelectionInteractionTool(tool);
}
