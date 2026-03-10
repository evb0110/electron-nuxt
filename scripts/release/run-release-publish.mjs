import {
    HostedWorkflowFailure,
    runPublishPhase,
} from './workflow-phase.mjs';

async function main() {
    const tag = process.argv[2];
    const preflightRunId = process.argv[3];
    await runPublishPhase({
        tag,
        preflightRunId,
    });
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (error instanceof HostedWorkflowFailure) {
        process.exit(1);
    }
    process.exit(2);
});
