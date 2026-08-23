export async function runStageBatches(stages, runStage) {
    const batches = [];
    for (const stage of stages) {
        const previous = batches.at(-1);
        if (stage.parallelPhase !== undefined && previous?.phase === stage.parallelPhase) {
            previous.stages.push(stage);
        } else {
            batches.push({
                phase: stage.parallelPhase,
                stages: [stage],
            });
        }
    }
    for (const batch of batches) {
        const outcomes = await Promise.allSettled(batch.stages.map(runStage));
        const failure = outcomes.find(outcome => outcome.status === 'rejected');
        if (failure?.status === 'rejected') {
            throw failure.reason;
        }
    }
}
