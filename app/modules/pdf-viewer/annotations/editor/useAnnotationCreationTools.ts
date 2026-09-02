import type {
    INoteEntity,
    ITextBoxEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
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
): ITextBoxEntity | INoteEntity | null;}

export const useAnnotationCreationTools = (
    options: IUseAnnotationCreationToolsOptions,
): IAnnotationCreationTools => ({create(tool, pageIndex, rect) {
    if (tool === 'text') {
        const entity = options.surface.createTextBoxAt(pageIndex, rect);
        options.surface.select([entity.identity.id]);
        return entity;
    }

    if (tool === 'note') {
        const entity = options.surface.createNoteAt(pageIndex, rect);
        options.surface.select([entity.identity.id]);
        return entity;
    }

    return null;
}});
