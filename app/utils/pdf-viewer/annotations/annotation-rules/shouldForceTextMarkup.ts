import type { TAnnotationTool } from '@app/types/annotations';

export function shouldForceTextMarkup(tool: TAnnotationTool) {
    return tool === 'underline' || tool === 'strikethrough' || tool === 'squiggly';
}
