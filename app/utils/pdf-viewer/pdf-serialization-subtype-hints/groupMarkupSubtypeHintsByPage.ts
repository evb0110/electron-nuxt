import { groupBy } from 'es-toolkit/array';
import type { IMarkupSubtypeHint } from '@app/utils/pdf-viewer/pdf-serialization-subtype-hints/pdfSerializationSubtypeHintsTypes';

export function groupMarkupSubtypeHintsByPage(hints: IMarkupSubtypeHint[]) {
    return new Map(
        Object.entries(groupBy(hints, hint => hint.pageIndex))
            .map(([
                pageIndex,
                pageHints,
            ]) => ([
                Number(pageIndex),
                pageHints,
            ])),
    );
}
