import type { scoreDeleteCandidate } from '@app/utils/pdf-viewer/annotations/annotation-delete-resolver/scoreDeleteCandidate';

export function pickScoredDeleteTarget(
    scored: Array<ReturnType<typeof scoreDeleteCandidate>>,
) {
    const best = scored[0];
    if (!best) {
        return null;
    }

    const second = scored[1];
    const isClearlyBetter = !second
        || (best.score - second.score >= 0.6)
        || (best.textExact && !second.textExact)
        || ((best.iou - (second.iou ?? 0)) >= 0.08);
    const acceptable = best.geometrySupported && (best.score >= 2.5 || best.textExact || best.iou >= 0.12);
    return acceptable && isClearlyBetter ? best.candidate : null;
}
