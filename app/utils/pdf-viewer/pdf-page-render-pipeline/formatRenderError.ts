import { errorToLogText } from '@app/utils/pdf-viewer/annotation-css-utils/errorToLogText';

export function formatRenderError(error: unknown, pageNumber: number) {
    return `Failed to render PDF page: ${pageNumber} ${errorToLogText(error)}`;
}
