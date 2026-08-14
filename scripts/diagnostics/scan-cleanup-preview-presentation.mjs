import {createHash} from 'node:crypto';
import {
    readFile,
    writeFile,
} from 'node:fs/promises';
import {
    createCanvas,
    loadImage,
} from '@napi-rs/canvas';

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

export async function composePreviewTransition(beforePath, afterPath, outputPath) {
    const [
        before,
        after,
    ] = await Promise.all([
        loadImage(beforePath),
        loadImage(afterPath),
    ]);
    const labelHeight = 52;
    const gap = 32;
    const width = before.width + after.width + gap;
    const height = Math.max(before.height, after.height) + labelHeight;
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#d0d0d0';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#202020';
    context.font = 'bold 24px sans-serif';
    context.fillText('Provisional', 12, 34);
    context.fillText('Settled candidate', before.width + gap + 12, 34);
    context.drawImage(before, 0, labelHeight);
    context.drawImage(after, before.width + gap, labelHeight);
    await writeFile(outputPath, canvas.toBuffer('image/png'));
}

export async function compareDisplayedPreviewLeaves(beforeLeaves, afterLeaves, measureMargins, compareMargins) {
    const halves = [...new Set([
        ...beforeLeaves.map(leaf => leaf.half),
        ...afterLeaves.map(leaf => leaf.half),
    ])];
    return Promise.all(halves.map(async half => {
        const beforeLeaf = beforeLeaves.find(leaf => leaf.half === half);
        const afterLeaf = afterLeaves.find(leaf => leaf.half === half);
        if (!beforeLeaf || !afterLeaf) {
            return {
                half,
                missingAfter: !afterLeaf,
                missingBefore: !beforeLeaf,
                rasterIdentical: false,
                inkMarginShift: null,
            };
        }
        const [
            beforeBytes,
            afterBytes,
        ] = await Promise.all([
            readFile(beforeLeaf.metricsPath),
            readFile(afterLeaf.metricsPath),
        ]);
        const rasterIdentical = sha256(beforeBytes) === sha256(afterBytes);
        return {
            half,
            rasterIdentical,
            inkMarginShift: rasterIdentical ? {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
                maximum: 0,
            } : compareMargins(
                await measureMargins(beforeLeaf.metricsPath),
                await measureMargins(afterLeaf.metricsPath),
            ),
        };
    }));
}

function comparisonMoved(comparison) {
    return comparison.missingBefore === true
        || comparison.missingAfter === true
        || comparison.rasterIdentical !== true
        || (comparison.inkMarginShift?.maximum ?? Number.POSITIVE_INFINITY) !== 0;
}

export async function measurePreviewPresentationStability({
    compareMargins,
    consumeSettle,
    graceWindowMs,
    measureMargins,
    previewLeaves,
    provisionalLeaves,
    resolveCommit,
    transitionKey,
}) {
    const firstCommit = resolveCommit(null, transitionKey, 0);
    const earlyCommit = resolveCommit(firstCommit.pin, transitionKey, 1_000);
    const secondAutomaticCommit = resolveCommit(earlyCommit.pin, transitionKey, 1_500);
    const settledPin = consumeSettle(secondAutomaticCommit.pin);
    const postWindowCommit = resolveCommit(settledPin, transitionKey, graceWindowMs + 1);
    const [
        earlySettleComparisons,
        secondAutomaticComparisons,
        settleCommitComparisons,
        postWindowComparisons,
    ] = await Promise.all([
        compareDisplayedPreviewLeaves(provisionalLeaves, provisionalLeaves, measureMargins, compareMargins),
        compareDisplayedPreviewLeaves(provisionalLeaves, provisionalLeaves, measureMargins, compareMargins),
        compareDisplayedPreviewLeaves(provisionalLeaves, previewLeaves, measureMargins, compareMargins),
        compareDisplayedPreviewLeaves(previewLeaves, previewLeaves, measureMargins, compareMargins),
    ]);
    return createPreviewPresentationStabilityReport({
        earlyCommit,
        earlySettleComparisons,
        graceWindowMs,
        settleCommitComparisons,
        postWindowCommit,
        postWindowComparisons,
        secondAutomaticCommit,
        secondAutomaticComparisons,
    });
}

export function createPreviewPresentationStabilityReport({
    earlyCommit,
    earlySettleComparisons,
    graceWindowMs,
    settleCommitComparisons,
    postWindowCommit,
    postWindowComparisons,
    secondAutomaticCommit,
    secondAutomaticComparisons,
}) {
    const violations = [];
    if (earlyCommit.action !== 'coalesce' || secondAutomaticCommit.action !== 'coalesce') {
        violations.push('presentation-pre-window-commit');
    }
    if (postWindowCommit.action !== 'reject') {
        violations.push('presentation-post-window-commit');
    }
    if (postWindowComparisons.some(comparisonMoved)) {
        violations.push('presentation-post-window-movement');
    }
    if ([
        ...earlySettleComparisons,
        ...secondAutomaticComparisons,
        ...settleCommitComparisons,
        ...postWindowComparisons,
    ].some(comparison => comparison.missingBefore === true || comparison.missingAfter === true)) {
        violations.push('presentation-missing-half');
    }
    return {
        graceWindowMs,
        earlyCandidate: {
            atMs: 1_000,
            action: earlyCommit.action,
            leaves: earlySettleComparisons,
        },
        latestCandidate: {
            atMs: 1_500,
            action: secondAutomaticCommit.action,
            leaves: secondAutomaticComparisons,
        },
        settleAtExpiry: {
            atMs: graceWindowMs,
            committed: true,
            leaves: settleCommitComparisons,
        },
        postWindow: {
            atMs: graceWindowMs + 1,
            action: postWindowCommit.action,
            leaves: postWindowComparisons,
        },
        violations,
    };
}
