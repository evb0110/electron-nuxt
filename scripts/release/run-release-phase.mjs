import {
    HostedWorkflowFailure,
    runPhaseFromCli,
} from './workflow-phase.mjs';

async function main() {
    await runPhaseFromCli();
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (error instanceof HostedWorkflowFailure) {
        process.exit(1);
    }
    process.exit(2);
});
