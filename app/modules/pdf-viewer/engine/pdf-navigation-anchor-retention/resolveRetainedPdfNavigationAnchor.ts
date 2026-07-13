interface IResolveRetainedPdfNavigationAnchorOptions {
    pendingTargetPage: number | null;
    retainedTargetPage: number | null;
    explicitCancel: boolean;
}

/**
 * Keeps the last navigation row mounted after authority commits. Releasing it
 * merely because it became visible can remove the row that defines scroll
 * geometry and blank or displace the just-reached destination.
 */
export function resolveRetainedPdfNavigationAnchor(
    options: IResolveRetainedPdfNavigationAnchorOptions,
) {
    if (options.explicitCancel) {
        return null;
    }
    return options.pendingTargetPage ?? options.retainedTargetPage;
}
