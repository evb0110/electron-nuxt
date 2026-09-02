import type { ITextBoxEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type { IAnnotationEditorSurface } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import type {
    IAnnotationMarkerRect,
    TAnnotationTool,
} from '@app/types/annotations';

interface IUseAnnotationCreationToolsOptions {surface: IAnnotationEditorSurface;}

export interface IAnnotationCreationTools {create(
    tool: TAnnotationTool,
    pageIndex: number,
    rect: IAnnotationMarkerRect,
): ITextBoxEntity | null;}

export const useAnnotationCreationTools = (
    options: IUseAnnotationCreationToolsOptions,
): IAnnotationCreationTools => ({create(tool, pageIndex, rect) {
    if (tool !== 'text') {
        return null;
    }
    const entity = options.surface.createTextBoxAt(pageIndex, rect);
    options.surface.select([entity.identity.id]);
    return entity;
}});
