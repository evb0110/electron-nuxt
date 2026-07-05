import {
    mkdtempSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import {
    dirname,
    join,
} from 'path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import type { IAgentAssistantChatScope } from '@contracts/agent';
import { AssistantChatPersistence } from '@electron/features/agent/assistantChatPersistence';
import { createAssistantChatSessionStore } from '@electron/features/agent/assistantChatSessionStore';
import { createAssistantSessionTurnCoordinator } from '@electron/features/agent/createAssistantSessionTurnCoordinator';
import type { IAssistantSelection } from '@electron/features/agent/assistantProviderStatus';

const tempRoots: string[] = [];

const scope = {
    kind: 'document',
    key: 'document:/tmp/a.pdf',
    title: 'a.pdf',
    tabId: 'tab-a',
    documentRef: '/tmp/a.pdf',
} satisfies IAgentAssistantChatScope;

const selection = {
    provider: 'codex',
    model: 'gpt-5',
    effort: 'medium',
    speedMode: 'standard',
} satisfies IAssistantSelection;

function createTempRoot() {
    const root = mkdtempSync(join(tmpdir(), 'evb-assistant-chat-'));
    tempRoots.push(root);
    return root;
}

function createPersistence(rootDir = createTempRoot(), options: Partial<ConstructorParameters<typeof AssistantChatPersistence>[0]> = {}) {
    return new AssistantChatPersistence({
        rootDir,
        maxSessionBytes: 64 * 1024,
        maxSessions: 16,
        ...options,
    });
}

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 20,
        });
    }
});

describe('assistant chat session store persistence', () => {
    it('writes JSONL transcripts and recovers messages', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir);
        const store = createAssistantChatSessionStore({ persistence });
        const session = store.getSession(scope, selection, { create: true });

        store.addMessage(session, {
            role: 'user',
            text: 'hello',
        });
        store.upsertAssistantMessage(session, 'assistant-1', {
            role: 'assistant',
            text: 'hi',
            pending: false,
        });
        await store.flushPersistenceForTests();

        const recoveredStore = createAssistantChatSessionStore({persistence: createPersistence(rootDir)});
        const messages = recoveredStore.getMessages(scope, selection);

        expect(messages).toHaveLength(2);
        expect(messages.map(message => [
            message.role,
            message.text,
        ])).toEqual([
            [
                'user',
                'hello',
            ],
            [
                'assistant',
                'hi',
            ],
        ]);
    });

    it('skips corrupt transcript lines while recovering valid snapshots', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir);
        const store = createAssistantChatSessionStore({ persistence });
        const session = store.getSession(scope, selection, { create: true });
        store.addMessage(session, {
            role: 'user',
            text: 'before corrupt line',
        });
        await store.flushPersistenceForTests();

        const transcriptPath = persistence.sessionPath(store.keyForSession(session));
        writeFileSync(transcriptPath, 'not json\n', { flag: 'a' });
        store.addMessage(session, {
            role: 'assistant',
            text: 'after corrupt line',
        });
        await store.flushPersistenceForTests();

        const recoveredStore = createAssistantChatSessionStore({persistence: createPersistence(rootDir)});

        expect(recoveredStore.getMessages(scope, selection).map(message => message.text)).toEqual([
            'before corrupt line',
            'after corrupt line',
        ]);
    });

    it('marks active turns as interrupted during recovery', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir);
        const store = createAssistantChatSessionStore({ persistence });
        const coordinator = createAssistantSessionTurnCoordinator({ sessionStore: store });
        const session = store.getSession(scope, selection, { create: true });

        coordinator.claimSessionTurn(session);
        coordinator.markSessionTurnRunning(session, session.turnOwner.generation, 'turn-1');
        store.upsertAssistantMessage(session, 'assistant-1', {
            role: 'assistant',
            text: 'partial',
            pending: true,
        });
        await store.flushPersistenceForTests();

        const recoveredStore = createAssistantChatSessionStore({persistence: createPersistence(rootDir)});
        const recovered = recoveredStore.getSession(scope, selection);

        expect(recovered?.turnOwner).toMatchObject({
            phase: 'error',
            generation: session.turnOwner.generation,
        });
        expect(recovered?.lastError).toContain('interrupted');
        expect(recovered?.messages[0]).toMatchObject({
            pending: false,
            error: expect.stringContaining('interrupted'),
        });
    });

    it('prunes persisted sessions by least recent access', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir, { maxSessions: 2 });
        const store = createAssistantChatSessionStore({
            persistence,
            maxEntries: 10,
        });

        for (const index of [
            1,
            2,
            3,
        ]) {
            const session = store.getSession({
                ...scope,
                key: `document:/tmp/${index}.pdf`,
                title: `${index}.pdf`,
            }, selection, { create: true });
            session.lastAccessedAtMs = index;
            store.addMessage(session, {
                role: 'user',
                text: `message-${index}`,
            });
            store.recordSessionSnapshot(session);
        }
        await store.flushPersistenceForTests();

        const recoveredStore = createAssistantChatSessionStore({
            persistence: createPersistence(rootDir, { maxSessions: 2 }),
            maxEntries: 10,
        });

        expect(recoveredStore.listSessions().map(session => session.scope.key).sort()).toEqual([
            'document:/tmp/2.pdf',
            'document:/tmp/3.pdf',
        ]);
    });

    it('archives transcripts when a session is reset', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir);
        const store = createAssistantChatSessionStore({ persistence });
        const session = store.getSession(scope, selection, { create: true });
        store.addMessage(session, {
            role: 'user',
            text: 'before reset',
        });
        await store.flushPersistenceForTests();

        session.messages.length = 0;
        store.resetSessionTranscript(session, 'reset');
        await store.flushPersistenceForTests();

        const archiveRoot = join(rootDir, 'archive');
        const archiveEntries = readdirSync(archiveRoot);
        const recoveredStore = createAssistantChatSessionStore({persistence: createPersistence(rootDir)});

        expect(archiveEntries.some(entry => entry.includes('.reset.'))).toBe(true);
        expect(recoveredStore.getMessages(scope, selection)).toEqual([]);
    });

    it('uses the expected storage layout under the persistence root', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir);
        const store = createAssistantChatSessionStore({ persistence });
        const session = store.getSession(scope, selection, { create: true });
        store.addMessage(session, {
            role: 'user',
            text: 'layout',
        });
        await store.flushPersistenceForTests();

        const transcriptPath = persistence.sessionPath(store.keyForSession(session));
        expect(dirname(transcriptPath)).toBe(join(rootDir, 'sessions'));
        expect(transcriptPath.endsWith('.jsonl')).toBe(true);
    });

    it('exposes a production persistence flush that drains queued snapshots', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir);
        const store = createAssistantChatSessionStore({ persistence });
        const session = store.getSession(scope, selection, { create: true });

        store.addMessage(session, {
            role: 'user',
            text: 'flush me',
        });
        await store.flushPersistence();

        const recoveredStore = createAssistantChatSessionStore({persistence: createPersistence(rootDir)});
        expect(recoveredStore.getMessages(scope, selection).map(message => message.text)).toEqual(['flush me']);
    });
});
