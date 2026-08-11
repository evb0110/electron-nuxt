import type {
    PDFDict,
    PDFDocument,
} from 'pdf-lib';
import {
    LineCapStyle,
    LineJoinStyle,
    PDFName,
    PDFNumber,
    lineTo,
    moveTo,
    popGraphicsState,
    pushGraphicsState,
    setGraphicsState,
    setLineCap,
    setLineJoin,
    setLineWidth,
    setStrokingRgbColor,
    stroke,
} from 'pdf-lib';
import type { IShapeAnnotation } from '@app/types/annotations';
import { parsePdfColor } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-colors/parsePdfColor';

const APPEARANCE_NAME = PDFName.of('AP');
const FLAGS_NAME = PDFName.of('F');
const PRINT_ANNOTATION_FLAG = 1 << 2;
const GRAPHICS_STATE_NAME = 'GS0';

function clampOpacity(value: number) {
    if (!Number.isFinite(value)) {
        return 1;
    }
    return Math.min(1, Math.max(0, value));
}

function ensurePrintAnnotationFlag(annotDict: PDFDict) {
    const existing = annotDict.lookupMaybe(FLAGS_NAME, PDFNumber)?.asNumber() ?? 0;
    annotDict.set(FLAGS_NAME, PDFNumber.of(Math.trunc(existing) | PRINT_ANNOTATION_FLAG));
}

/**
 * Writes a self-contained normal appearance for an Ink annotation.
 *
 * InkList remains the editable semantic geometry. The appearance is the
 * portable rendering fallback for readers that do not synthesize Ink visuals
 * from InkList and BS alone (notably Quartz/Preview).
 */
export function applyInkAnnotationAppearance(
    annotDict: PDFDict,
    doc: PDFDocument,
    shape: Pick<IShapeAnnotation, 'color' | 'opacity' | 'strokeWidth'>,
    inkList: number[][],
    rect: [number, number, number, number],
) {
    const operators = [
        pushGraphicsState(),
        setGraphicsState(GRAPHICS_STATE_NAME),
    ];
    const color = parsePdfColor(shape.color) ?? [
        0,
        0,
        0,
    ];
    operators.push(
        setStrokingRgbColor(...color),
        setLineWidth(shape.strokeWidth),
        setLineCap(LineCapStyle.Round),
        setLineJoin(LineJoinStyle.Round),
    );

    let hasPath = false;
    inkList.forEach((strokePoints) => {
        if (strokePoints.length < 4) {
            return;
        }
        operators.push(moveTo(strokePoints[0]!, strokePoints[1]!));
        for (let index = 2; index + 1 < strokePoints.length; index += 2) {
            operators.push(lineTo(strokePoints[index]!, strokePoints[index + 1]!));
        }
        hasPath = true;
    });
    if (!hasPath) {
        return false;
    }
    operators.push(stroke(), popGraphicsState());

    const opacity = clampOpacity(shape.opacity);
    const appearanceRef = doc.context.register(doc.context.formXObject(operators, {
        BBox: doc.context.obj(rect),
        Matrix: doc.context.obj([
            1,
            0,
            0,
            1,
            0,
            0,
        ]),
        Resources: doc.context.obj({ExtGState: {[GRAPHICS_STATE_NAME]: {
            Type: 'ExtGState',
            CA: opacity,
            ca: opacity,
        }}}),
    }));
    annotDict.set(APPEARANCE_NAME, doc.context.obj({N: appearanceRef}));
    ensurePrintAnnotationFlag(annotDict);
    return true;
}
