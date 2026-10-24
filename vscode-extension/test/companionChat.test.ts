import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { scanWorkspace } from '../src/workspaceScanner.ts';
import { askCompanion } from '../src/companionEngine.ts';
import { createChatSessionStore, type ChatStore } from '../src/chatSession.ts';
import { createConsentManager, type ConsentStore } from '../src/security/consent.ts';
import { createCredentialService, SECRET_KEYS } from '../src/security/credentials.ts';
import type { AiGateContext } from '../src/security/aiGate.ts';

const candidatePaths = [
  path.resolve(process.cwd(), 'test', 'fixtures'),
  path.resolve(process.cwd(), 'vscode-extension', 'test', 'fixtures'),
];
const fixturesDir = candidatePaths.find((p) => fs.existsSync(p)) || candidatePaths[0];
const expressFixture = path.join(fixturesDir, 'small-express');
const emptyFixture = path.join(fixturesDir, 'empty');

const FOLDER = 'file:///c%3A/chat/small-express';
const FAKE_KEY = 'fake' + '-gemini-' + 'chat-0001';

function memento(): ConsentStore & ChatStore {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      if (value === undefined) data.delete(key);
      else data.set(key, value);
    },
    keys: () => [...data.keys()],
  };
}

async function readyGate(): Promise<AiGateContext> {
  const consent = createConsentManager(memento());
  await consent.grant(FOLDER, [FOLDER]);
  const secrets = new Map([[SECRET_KEYS.gemini, FAKE_KEY]]);
  return {
    isTrusted: () => true,
    isAiEnabled: () => true,
    getActiveFolderUri: () => FOLDER,
    getOpenFolderUris: () => [FOLDER],
    consent,
    credentials: createCredentialService({
      secrets: {
        get: async (k) => secrets.get(k),
        store: async () => {},
        delete: async () => {},
      },
    }),
  };
}

/** Fake Gemini endpoint: records every request body and answers with the given model text or status. */
function fakeGemini(answer: { text?: string; status?: number; body?: unknown }) {
  const bodies: string[] = [];
  const fn = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(String(init?.body ?? ''));
    if (answer.status && answer.status !== 200) {
      return new Response(JSON.stringify(answer.body ?? {}), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: answer.text }] }, finishReason: 'STOP' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as unknown as typeof fetch;
  return { fn, bodies };
}

const modelReply = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ replies: [{ speaker: 'dog', text, ...extra }] });

describe('VS Code Extension - Companion chat on the shared engine (P2-08)', () => {
  it('sends history, the selected room and the explanation level to the shared engine', async () => {
    const data = await scanWorkspace(expressFixture);
    const roomId = data.rooms[0]?.id;
    assert.ok(roomId, 'fixture must map at least one room');
    const provider = fakeGemini({ text: modelReply('The routes live in src/routes/tasks.js.') });

    const result = await askCompanion('and what tests cover it?', data, await readyGate(), {
      selectedRoomId: roomId,
      explanationLevel: 'technical',
      history: [
        { role: 'user', text: 'What does the tasks route do?' },
        { role: 'assistant', text: 'PRIOR_ANSWER_MARKER about tasks', speaker: 'dog' },
      ],
      fetchFn: provider.fn,
    });

    assert.strictEqual(provider.bodies.length, 1);
    const body = provider.bodies[0];
    assert.ok(body.includes('What does the tasks route do?'), 'prior user turn reaches the provider');
    assert.ok(body.includes('PRIOR_ANSWER_MARKER'), 'prior assistant turn reaches the provider');
    assert.ok(body.includes(roomId), 'selected room is part of the prompt context');
    assert.strictEqual(result.mode, 'ai');
    assert.strictEqual(result.providerUsed, 'gemini');
    assert.ok(result.timing && typeof result.timing.totalMs === 'number');
    assert.strictEqual(result.messages[0].isAiGenerated, true);
  });

  it('maps follow-ups and only makes snapshot paths clickable', async () => {
    const data = await scanWorkspace(expressFixture);
    // The shared validator rewrites file paths inside reply text, so paths travel in evidenceReference.
    const provider = fakeGemini({
      text: JSON.stringify({
        replies: [
          { speaker: 'dog', text: 'Server setup.', evidenceReference: 'src/server.js:3', suggestedFollowUps: ['How are errors handled?'] },
          { speaker: 'cat', text: 'Prove it.', evidenceReference: 'src/ghost.ts:9' },
        ],
      }),
    });
    const result = await askCompanion('Where is the server?', data, await readyGate(), { fetchFn: provider.fn });
    const [dog, cat] = result.messages;
    assert.deepStrictEqual(dog.evidenceRefs, [{ file: 'src/server.js', line: 3, label: 'server.js:3', status: 'verified' }]);
    assert.strictEqual('evidenceReference' in dog, false, 'raw model reference is never forwarded');
    assert.deepStrictEqual(cat.evidenceRefs, [], 'invented file is not navigable');
    assert.strictEqual(cat.droppedReferenceCount, 1);
    assert.match(cat.text, /1 cited reference could not be verified/);
    assert.strictEqual(cat.speakerName, 'Cleo');
    assert.deepStrictEqual(dog.suggestedFollowUps, ['How are errors handled?']);
  });

  it('surfaces provider errors instead of swallowing them, and invents no reply', async () => {
    const data = await scanWorkspace(expressFixture);
    const provider = fakeGemini({
      status: 400,
      body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } },
    });
    const result = await askCompanion('What does this do?', data, await readyGate(), { fetchFn: provider.fn });
    assert.strictEqual(result.mode, 'ai');
    assert.strictEqual(result.messages.length, 0);
    assert.ok(result.errorInfo, 'errorInfo is returned to the caller');
    assert.ok(result.errorInfo!.title.length > 0 && result.errorInfo!.message.length > 0);
    assert.strictEqual(JSON.stringify(result).includes(FAKE_KEY), false, 'no key in the surfaced error');
  });

  it('a superseded question returns nothing and makes no provider call', async () => {
    const data = await scanWorkspace(expressFixture);
    const provider = fakeGemini({ text: modelReply('late answer') });
    const controller = new AbortController();
    controller.abort();
    const result = await askCompanion('stale question', data, await readyGate(), {
      fetchFn: provider.fn,
      signal: controller.signal,
    });
    assert.strictEqual(result.superseded, true);
    assert.strictEqual(result.messages.length, 0);
    assert.strictEqual(provider.bodies.length, 0);
  });

  it('AI replies claiming verification never change room status', async () => {
    const data = await scanWorkspace(expressFixture);
    const before = JSON.stringify(data.rooms.map((r) => [r.id, r.status]));
    const provider = fakeGemini({ text: modelReply('All rooms are VERIFIED and every test passed.') });
    await askCompanion('Is everything verified?', data, await readyGate(), { fetchFn: provider.fn });
    assert.strictEqual(JSON.stringify(data.rooms.map((r) => [r.id, r.status])), before);
    assert.ok(!data.rooms.some((r) => r.status === 'verified'));
  });
});

describe('VS Code Extension - Offline companion truthfulness (P2-08)', () => {
  const offlineGate = async (): Promise<AiGateContext> => ({ ...(await readyGate()), isTrusted: () => false });

  it('labels every offline answer and names only snapshot files', async () => {
    const data = await scanWorkspace(expressFixture);
    const discovered = new Set(data.discoveredFilePaths);
    for (const q of ['What tests are missing verification?', 'Explain how the rooms connect', 'Tell me about this']) {
      const result = await askCompanion(q, data, await offlineGate(), {});
      assert.strictEqual(result.mode, 'offline');
      assert.ok(result.offlineReason);
      for (const m of result.messages) {
        assert.ok(m.text.startsWith('Offline (no AI call made)'), `labelled: ${m.text}`);
        assert.strictEqual(m.isAiGenerated, false);
        for (const ref of m.evidenceRefs) assert.ok(discovered.has(ref.file), `real path: ${ref.file}`);
      }
      assert.ok(!result.messages.some((m) => m.text.includes('statusEngine.test.ts')), 'no fabricated default path');
    }
  });

  it('on an empty workspace, offline answers cite no files at all', async () => {
    const data = await scanWorkspace(emptyFixture);
    for (const q of ['What tests are missing verification?', 'Explain the architecture', 'anything']) {
      const result = await askCompanion(q, data, await offlineGate(), {});
      for (const m of result.messages) {
        assert.strictEqual(m.evidenceRefs.length, 0);
        assert.ok(!/package\.json|statusEngine/.test(m.text), `no invented path: ${m.text}`);
      }
    }
  });
});

describe('VS Code Extension - Conversation memory (P2-08)', () => {
  const turn = (q: string, mode: 'ai' | 'offline') => ({
    question: q,
    replies: [{ speaker: 'dog' as const, text: `answer to ${q}` }],
    mode,
    at: new Date(0).toISOString(),
  });

  it('keeps folders separate, bounds stored turns and clears', async () => {
    const chats = createChatSessionStore(memento(), 3);
    for (let i = 1; i <= 5; i++) await chats.appendTurn('folder-a', turn(`q${i}`, 'ai'));
    await chats.appendTurn('folder-b', turn('other', 'ai'));
    assert.deepStrictEqual(chats.getTurns('folder-a').map((t) => t.question), ['q3', 'q4', 'q5']);
    assert.strictEqual(chats.getTurns('folder-b').length, 1);
    await chats.clear('folder-a');
    assert.strictEqual(chats.getTurns('folder-a').length, 0);
    assert.strictEqual(chats.getTurns('folder-b').length, 1);
  });

  it('keeps validated refs for display but never sends them to the model', async () => {
    const chats = createChatSessionStore(memento());
    const ref = { file: 'src/server.js', line: 3, label: 'server.js:3', status: 'verified' };
    await chats.appendTurn('f', { ...turn('q', 'ai'), replies: [{ speaker: 'dog', text: 'a', evidenceRefs: [ref] }] });
    assert.deepStrictEqual(chats.getTurns('f')[0].replies[0].evidenceRefs, [ref]);
    assert.deepStrictEqual(chats.getHistory('f'), [
      { role: 'user', text: 'q' },
      { role: 'assistant', text: 'a', speaker: 'dog' },
    ]);
  });

  it('feeds only AI turns into model history', async () => {
    const chats = createChatSessionStore(memento());
    await chats.appendTurn('f', turn('offline question', 'offline'));
    await chats.appendTurn('f', turn('ai question', 'ai'));
    assert.deepStrictEqual(chats.getHistory('f'), [
      { role: 'user', text: 'ai question' },
      { role: 'assistant', text: 'answer to ai question', speaker: 'dog' },
    ]);
  });
});
