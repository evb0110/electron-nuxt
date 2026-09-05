export interface IMarkerObservation {
    pageNumber: number;
    text: string;
}

export function collectMarkerFailures(
    observations: readonly IMarkerObservation[],
    expectedMarkers: readonly string[],
    forbiddenMarkers: readonly string[] | undefined,
    describeMismatch: (marker: string, observation: IMarkerObservation, index: number) => string | undefined,
) {
    const failures: string[] = [];
    if (observations.length !== expectedMarkers.length) {
        failures.push(
            `document has ${observations.length} pages but ${expectedMarkers.length} markers were expected`,
        );
    }
    expectedMarkers.forEach((marker, index) => {
        const observation = observations[index];
        if (observation === undefined) {
            failures.push(`page ${index + 1} is missing, expected marker ${marker}`);
            return;
        }
        const mismatch = describeMismatch(marker, observation, index);
        if (mismatch !== undefined) {
            failures.push(mismatch);
        }
    });
    const wholeDocumentText = observations.map(observation => observation.text).join('\n');
    for (const forbidden of forbiddenMarkers ?? []) {
        if (wholeDocumentText.includes(forbidden)) {
            failures.push(`forbidden marker ${forbidden} is present`);
        }
    }
    return failures;
}
