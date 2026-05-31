type TTaskResolver = () => void;

let taskChannel: MessageChannel | null | undefined;
const pendingTaskResolvers: TTaskResolver[] = [];

function getVisibilityState() {
    if (typeof document === 'undefined') {
        return 'hidden';
    }

    return document.visibilityState;
}

function getTaskChannel() {
    if (taskChannel !== undefined) {
        return taskChannel;
    }

    if (typeof MessageChannel !== 'function') {
        taskChannel = null;
        return taskChannel;
    }

    taskChannel = new MessageChannel();
    taskChannel.port1.onmessage = () => {
        pendingTaskResolvers.shift()?.();
    };
    return taskChannel;
}

async function yieldToTaskQueue() {
    const channel = getTaskChannel();
    if (channel) {
        await new Promise<void>((resolve) => {
            pendingTaskResolvers.push(resolve);
            channel.port2.postMessage(undefined);
        });
        return;
    }

    await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });
}

export async function yieldToBrowser() {
    if (
        getVisibilityState() === 'visible'
        && typeof requestAnimationFrame === 'function'
    ) {
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
        });
        return;
    }

    await yieldToTaskQueue();
}

export function resetBrowserYieldStateForTests() {
    pendingTaskResolvers.length = 0;
    taskChannel = undefined;
}
