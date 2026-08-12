const DEFAULT_TOLERANCE_MM = 3;

function round(value) {
    return Math.round(value * 10_000) / 10_000;
}

export function contentBboxHeightFraction(grid, horizontalMargin = 0) {
    let minRow = -1;
    let maxRow = -1;
    const margin = Math.min(horizontalMargin, Math.floor(grid.cols / 2));
    for (let row = 0; row < grid.rows; row += 1) {
        const rowOffset = row * grid.cols;
        const rowHasInk = grid.dark
            .subarray(rowOffset + margin, rowOffset + grid.cols - margin)
            .some(cell => cell === 1);
        if (rowHasInk) {
            minRow = minRow === -1 ? row : minRow;
            maxRow = row;
        }
    }
    return minRow === -1 ? 0 : (maxRow - minRow + 1) / grid.rows;
}

export function buildExpectationInfos({
    expectSingles,
    inferredLayouts,
}) {
    const mismatches = inferredLayouts.flatMap((layout, index) => {
        const sourcePage = index + 1;
        const expectedLayout = expectSingles.has(sourcePage) ? 'single' : 'spread';
        return layout === expectedLayout ? [] : [{
            actual: layout,
            expected: expectedLayout,
            sourcePage,
        }];
    });
    if (mismatches.length === 0) {
        return [];
    }
    return [{
        code: 'expectation-mismatch',
        details: mismatches,
        message: 'Rendered output/source evidence inferred a different layout than the legacy manifest hint; this is INFO only and does not count as a violation.',
    }];
}

function contentTopPixels(bitmap) {
    // Keep the oracle's vertical anchor in the same pixel space as the native
    // matched-canvas planner. A dark-ink grid misses pale photo skies and can
    // report different tops for otherwise aligned leaves. The row guard
    // rejects isolated dust while retaining genuine low-contrast content.
    const contentBelowPaper = 245;
    const minimumRowPixels = 3;
    for (let y = 0; y < bitmap.height; y += 1) {
        let contentPixels = 0;
        const rowOffset = y * bitmap.width;
        for (let x = 0; x < bitmap.width; x += 1) {
            if (bitmap.data[rowOffset + x] < contentBelowPaper) {
                contentPixels += 1;
                if (contentPixels >= minimumRowPixels) {
                    return y;
                }
            }
        }
    }
    return null;
}

export function measureSpreadLeafVerticalAlignment({
    cleanedLeft,
    cleanedRight,
    dpi,
    sourceLeft,
    sourceRight,
    toleranceMm = DEFAULT_TOLERANCE_MM,
}) {
    const sourceLeftTop = contentTopPixels(sourceLeft);
    const sourceRightTop = contentTopPixels(sourceRight);
    const cleanedLeftTop = cleanedLeft ? contentTopPixels(cleanedLeft) : null;
    const cleanedRightTop = cleanedRight ? contentTopPixels(cleanedRight) : null;
    const result = {
        cleaned: {
            leftTopPx: cleanedLeftTop === null ? null : round(cleanedLeftTop),
            rightTopPx: cleanedRightTop === null ? null : round(cleanedRightTop),
        },
        dpi,
        source: {
            leftTopPx: sourceLeftTop === null ? null : round(sourceLeftTop),
            rightTopPx: sourceRightTop === null ? null : round(sourceRightTop),
        },
        status: 'not-measurable',
        toleranceMm,
        violations: [],
    };
    if (
        sourceLeftTop === null
        || sourceRightTop === null
        || cleanedLeftTop === null
        || cleanedRightTop === null
    ) {
        result.reason = 'content-top-not-measurable';
        return result;
    }

    const sourceDeltaPx = sourceRightTop - sourceLeftTop;
    const outputDeltaPx = cleanedRightTop - cleanedLeftTop;
    const deltaDifferencePx = outputDeltaPx - sourceDeltaPx;
    const deltaExcessPx = Math.max(0, Math.abs(outputDeltaPx) - Math.abs(sourceDeltaPx));
    const tolerancePx = dpi * toleranceMm / 25.4;
    result.source.deltaPx = round(sourceDeltaPx);
    result.source.deltaMm = round(sourceDeltaPx * 25.4 / dpi);
    result.cleaned.deltaPx = round(outputDeltaPx);
    result.cleaned.deltaMm = round(outputDeltaPx * 25.4 / dpi);
    result.deltaDifferencePx = round(deltaDifferencePx);
    result.deltaDifferenceMm = round(deltaDifferencePx * 25.4 / dpi);
    result.deltaExcessPx = round(deltaExcessPx);
    result.deltaExcessMm = round(deltaExcessPx * 25.4 / dpi);
    result.tolerancePx = round(tolerancePx);
    result.status = deltaExcessPx > tolerancePx ? 'violation' : 'pass';
    if (result.status === 'violation') {
        result.violations.push('leaf-misalignment');
    }
    return result;
}

export function buildSpreadLeafAlignment({
    cleanedPages,
    dpi,
    entries,
    sourcePages,
    splitHalves,
}) {
    const pairs = [];
    for (let index = 0; index < entries.length; index += 2) {
        const leftEntry = entries[index];
        const rightEntry = entries[index + 1];
        if (
            !leftEntry
            || !rightEntry
            || leftEntry.side !== 'left'
            || rightEntry.side !== 'right'
            || leftEntry.sourceLayout !== 'spread'
            || rightEntry.sourceLayout !== 'spread'
            || leftEntry.sourcePage !== rightEntry.sourcePage
        ) {
            continue;
        }
        const sourceHalves = splitHalves(sourcePages.get(leftEntry.sourcePage));
        const measurement = measureSpreadLeafVerticalAlignment({
            cleanedLeft: cleanedPages.get(leftEntry.cleanedPage) ?? null,
            cleanedRight: cleanedPages.get(rightEntry.cleanedPage) ?? null,
            dpi,
            sourceLeft: sourceHalves.left,
            sourceRight: sourceHalves.right,
        });
        pairs.push({
            leftCleanedPage: leftEntry.cleanedPage,
            rightCleanedPage: rightEntry.cleanedPage,
            sourcePage: leftEntry.sourcePage,
            ...measurement,
        });
    }
    return pairs;
}
