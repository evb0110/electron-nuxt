import type { RenderTask } from 'pdfjs-dist';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';

const BEGIN_ANNOTATION_OP = 80;
const END_ANNOTATION_OP = 81;

interface IRuntimeOperatorList {
    fnArray: ArrayLike<number>;
    argsArray: ArrayLike<unknown>;
}

function resolveRuntimeOperatorList(task: RenderTask | null): IRuntimeOperatorList | null {
    if (!task || typeof task !== 'object') {
        return null;
    }
    const internalTask: unknown = Reflect.get(task, '_internalRenderTask');
    if (!internalTask || typeof internalTask !== 'object') {
        return null;
    }
    const operatorList: unknown = Reflect.get(internalTask, 'operatorList');
    if (!operatorList || typeof operatorList !== 'object') {
        return null;
    }
    const fnArray: unknown = Reflect.get(operatorList, 'fnArray');
    const argsArray: unknown = Reflect.get(operatorList, 'argsArray');
    if (!Array.isArray(fnArray) || !Array.isArray(argsArray)) {
        return null;
    }
    return {
        fnArray,
        argsArray,
    };
}

export function createRenderTaskHiddenAnnotationOperationsFilter(hiddenAnnotationIds: ReadonlySet<string>) {
    const normalizedHiddenIds = new Set<string>();
    hiddenAnnotationIds.forEach((id) => {
        const normalizedId = normalizePdfJsAnnotationId(id);
        if (normalizedId) {
            normalizedHiddenIds.add(normalizedId);
        }
    });
    let renderTask: RenderTask | null = null;
    const annotationStack: boolean[] = [];
    let hiddenDepth = 0;
    let callCount = 0;
    let hiddenMatchCount = 0;
    const seenAnnotationIds = new Set<string>();

    return {
        bindTask(task: RenderTask) {
            renderTask = task;
            return Boolean(resolveRuntimeOperatorList(renderTask));
        },
        filter(index: number) {
            callCount += 1;
            const operatorList = resolveRuntimeOperatorList(renderTask);
            if (!operatorList) {
                return true;
            }
            const fn = operatorList.fnArray[index];
            if (fn === BEGIN_ANNOTATION_OP) {
                const args = operatorList.argsArray[index];
                const annotationId = Array.isArray(args) && typeof args[0] === 'string'
                    ? normalizePdfJsAnnotationId(args[0])
                    : null;
                if (annotationId) {
                    seenAnnotationIds.add(annotationId);
                }
                const isHidden = Boolean(annotationId && normalizedHiddenIds.has(annotationId));
                if (isHidden) {
                    hiddenMatchCount += 1;
                }
                annotationStack.push(isHidden);
                if (isHidden) {
                    hiddenDepth += 1;
                }
                return hiddenDepth === 0;
            }
            const shouldInclude = hiddenDepth === 0;
            if (fn === END_ANNOTATION_OP) {
                const wasHidden = annotationStack.pop() ?? false;
                if (wasHidden) {
                    hiddenDepth = Math.max(0, hiddenDepth - 1);
                }
                return shouldInclude;
            }
            return shouldInclude;
        },
        getDiagnostics() {
            return {
                callCount,
                hiddenMatchCount,
                hiddenAnnotationIds: Array.from(normalizedHiddenIds),
                seenAnnotationIds: Array.from(seenAnnotationIds),
            };
        },
    };
}
