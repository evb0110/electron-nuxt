import type {
    IAgentAssistantEvent,
    IAgentAssistantTokenUsage,
} from '@contracts/agent';
import type { IAssistantChatSession } from '@electron/features/agent/assistantChatSessionStore';
import type { IClaudeAssistantToolActivity } from '@electron/features/agent/claudeAssistantStreamPresentation';

export function createClaudeTurnPresentationCallbacks(options: {
    session: IAssistantChatSession;
    shouldDrop(turnId: string | null): boolean;
    publish(event: IAgentAssistantEvent): void;
}) {
    return {
        onToolActivity(turnId: string | null, nextActivity: IClaudeAssistantToolActivity) {
            if (options.shouldDrop(turnId)) {
                return;
            }
            const now = Date.now();
            const existing = options.session.turnPresentation.toolActivity.find(
                activity => activity.toolId === nextActivity.toolId,
            );
            const activity = existing ?? {
                toolId: nextActivity.toolId,
                name: nextActivity.name,
                phase: nextActivity.phase,
                startedAtMs: now,
            };
            activity.name = nextActivity.name;
            activity.phase = nextActivity.phase;
            if (nextActivity.phase !== 'running') {
                activity.completedAtMs = now;
            }
            if (!existing) {
                options.session.turnPresentation.toolActivity.push(activity);
            }
            const phase = nextActivity.phase === 'running' ? 'tool-running' : 'finalizing';
            options.session.turnPresentation.phase = phase;
            options.session.turnPresentation.lastEventAtMs = now;
            options.publish({
                type: 'turn-progress',
                phase,
                toolActivity: activity,
                lastEventAtMs: now,
            });
        },
        onUsage(turnId: string | null, usage: IAgentAssistantTokenUsage) {
            if (options.shouldDrop(turnId)) {
                return;
            }
            options.session.turnPresentation.usage = usage;
            options.session.turnPresentation.lastEventAtMs = Date.now();
        },
    };
}
