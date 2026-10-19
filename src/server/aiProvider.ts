import { buildSystemPrompt, isDiagramIntentRequested } from './contextBuilder.ts';
import { validateWorkflowDiagram } from '../domain/workflow/workflowValidator.ts';
import {
  buildChatCacheKey,
  getCachedChatResponse,
  setCachedChatResponse,
} from './responseCache.ts';
import type {
  ChatApiRequest,
  ChatApiResponse,
  CompanionReplyMessage,
  WorkflowDiagram,
  ValidatedChatResponse,
} from './types.ts';

export type { ValidatedChatResponse };

export function parseAndValidateChatResponse(
  rawJsonText: string,
  repoContext?: ChatApiRequest['repoContext']
): ValidatedChatResponse {
  let cleaned = rawJsonText.trim();
  // Strip Markdown code fencing if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('Malformed JSON received from AI model.');
  }

  let rawReplies: unknown;
  let rawWorkflowDiagram: unknown;
  let isComplete: boolean | undefined;
  let nextSpeaker: 'dog' | 'cat' | undefined;

  if (Array.isArray(parsed)) {
    rawReplies = parsed;
    // Check if any item contains an embedded workflowDiagram
    for (const item of parsed) {
      if (item && typeof item === 'object' && 'workflowDiagram' in item) {
        rawWorkflowDiagram = (item as Record<string, unknown>).workflowDiagram;
        break;
      }
    }
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.replies)) {
      rawReplies = obj.replies;
    } else if (obj.reply && typeof obj.reply === 'object') {
      rawReplies = [obj.reply];
    } else if (typeof obj.speaker === 'string' && typeof obj.text === 'string') {
      rawReplies = [obj];
    } else {
      rawReplies = obj.replies;
    }
    rawWorkflowDiagram = obj.workflowDiagram;
    if (typeof obj.isComplete === 'boolean') {
      isComplete = obj.isComplete;
    }
    if (obj.nextSpeaker === 'dog' || obj.nextSpeaker === 'cat') {
      nextSpeaker = obj.nextSpeaker;
    }
  } else {
    throw new Error('Model output must be a JSON array of messages or an object containing replies.');
  }

  if (!Array.isArray(rawReplies)) {
    throw new Error('Model output must be a JSON array of messages.');
  }

  if (rawReplies.length === 0) {
    throw new Error('Model output must contain at least one message.');
  }

  const validSpeakers = new Set(['dog', 'cat']);
  const validatedReplies: CompanionReplyMessage[] = [];
  const inspectedPaths = repoContext?.inspectedFiles?.map((f) => f.path).filter(Boolean) || [];

  for (const item of rawReplies.slice(0, 16)) {
    if (!item || typeof item !== 'object') {
      throw new Error('Message entry must be an object.');
    }

    const {
      speaker,
      text,
      evidenceReference,
      workflowDiagram: itemDiagram,
      suggestedFollowUps: itemFollowUps,
    } = item as Record<string, unknown>;

    if (typeof speaker !== 'string' || !validSpeakers.has(speaker.toLowerCase())) {
      throw new Error(`Invalid speaker ID: "${speaker}". Expected "dog" or "cat".`);
    }

    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('Message text cannot be empty.');
    }

    if (!rawWorkflowDiagram && itemDiagram) {
      rawWorkflowDiagram = itemDiagram;
    }

    let validatedFollowUps: string[] | undefined;
    if (Array.isArray(itemFollowUps)) {
      const clean = itemFollowUps
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .slice(0, 3)
        .map((s) => s.trim().slice(0, 120));
      if (clean.length > 0) validatedFollowUps = clean;
    }

    const normalizedSpeaker = speaker.toLowerCase() as 'dog' | 'cat';
    let cleanText = text.trim();

    // Cat (Cleo) responses must be ultra-concise and technical (bound to 350 chars max)
    if (normalizedSpeaker === 'cat') {
      cleanText = cleanText.slice(0, 350);
    } else {
      cleanText = cleanText.slice(0, 2000);
    }

    // Safeguard: Barkley must never provide filenames or file paths
    if (normalizedSpeaker === 'dog' && inspectedPaths.length > 0) {
      for (const p of inspectedPaths) {
        if (cleanText.includes(p)) {
          cleanText = cleanText.split(`\`${p}\``).join('the relevant code')
                               .split(p).join('the relevant code');
        }
      }
    }

    validatedReplies.push({
      speaker: normalizedSpeaker,
      text: cleanText,
      evidenceReference:
        typeof evidenceReference === 'string' && evidenceReference.trim().length > 0
          ? evidenceReference.trim().slice(0, 150)
          : undefined,
      suggestedFollowUps: validatedFollowUps,
    });
  }

  let validatedDiagram: WorkflowDiagram | undefined;
  if (rawWorkflowDiagram) {
    const sanitized = validateWorkflowDiagram(rawWorkflowDiagram, repoContext);
    if (sanitized) {
      validatedDiagram = sanitized;
      // Attach to primary speaking pet's message
      if (validatedReplies.length > 0) {
        validatedReplies[0].workflowDiagram = sanitized;
      }
    }
  }

  return {
    replies: validatedReplies,
    reply: validatedReplies[0],
    isComplete,
    nextSpeaker,
    workflowDiagram: validatedDiagram,
  };
}

export function parseAndValidateReplies(
  rawJsonText: string,
  repoContext?: ChatApiRequest['repoContext']
): CompanionReplyMessage[] {
  const result = parseAndValidateChatResponse(rawJsonText, repoContext);
  return result.replies;
}

export function getThinkingConfig(
  env: Record<string, string | undefined> = process.env
): { thinkingLevel: 'low' | 'high' } {
  const envVal = (env.GEMINI_THINKING_LEVEL || env.AI_THINKING_LEVEL || 'low').trim().toLowerCase();
  if (envVal === 'high') {
    return { thinkingLevel: 'high' };
  }
  // Default is 'low' per T16 specification (reduces latency on Gemini 3.8 Flash)
  return { thinkingLevel: 'low' };
}

import { executeAiWithFallback } from './aiProviderRunner.ts';

export function getChatResponseSchema(includeDiagram: boolean, isFragment = false) {
  if (isFragment) {
    return {
      type: 'OBJECT',
      properties: {
        reply: {
          type: 'OBJECT',
          properties: {
            speaker: { type: 'STRING', enum: ['dog', 'cat'] },
            text: { type: 'STRING' },
            evidenceReference: { type: 'STRING' },
          },
          required: ['speaker', 'text'],
        },
        replies: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              speaker: { type: 'STRING', enum: ['dog', 'cat'] },
              text: { type: 'STRING' },
              evidenceReference: { type: 'STRING' },
            },
            required: ['speaker', 'text'],
          },
        },
        isComplete: { type: 'BOOLEAN' },
        nextSpeaker: { type: 'STRING', enum: ['dog', 'cat'] },
      },
    };
  }

  const repliesSchema = {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        speaker: { type: 'STRING', enum: ['dog', 'cat'] },
        text: { type: 'STRING' },
        evidenceReference: { type: 'STRING' },
        suggestedFollowUps: {
          type: 'ARRAY',
          items: { type: 'STRING' },
        },
      },
      required: ['speaker', 'text'],
    },
  };

  if (!includeDiagram) {
    return {
      type: 'OBJECT',
      properties: {
        replies: repliesSchema,
      },
      required: ['replies'],
    };
  }

  return {
    type: 'OBJECT',
    properties: {
      replies: repliesSchema,
      workflowDiagram: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          title: { type: 'STRING' },
          explanation: { type: 'STRING' },
          simulationType: { type: 'STRING' },
          nodes: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                id: { type: 'STRING' },
                label: { type: 'STRING' },
                role: { type: 'STRING' },
                nodeType: { type: 'STRING', enum: ['component', 'decision', 'storage', 'external', 'step'] },
                roomId: { type: 'STRING' },
                filePath: { type: 'STRING' },
                classification: { type: 'STRING', enum: ['observed', 'inferred'] },
                description: { type: 'STRING' },
                inputs: { type: 'STRING' },
                outputs: { type: 'STRING' },
              },
              required: ['id', 'label', 'classification', 'description'],
            },
          },
          edges: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                from: { type: 'STRING' },
                to: { type: 'STRING' },
                label: { type: 'STRING' },
                branchLabel: { type: 'STRING' },
                classification: { type: 'STRING', enum: ['observed', 'inferred'] },
                evidenceReference: { type: 'STRING' },
              },
              required: ['from', 'to', 'classification'],
            },
          },
          uncertainties: { type: 'STRING' },
        },
        required: ['title', 'explanation', 'nodes', 'edges'],
      },
    },
    required: ['replies'],
  };
}

export async function executeAiChat(
  request: ChatApiRequest,
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch
): Promise<ChatApiResponse> {
  const startTime = Date.now();

  // Validate user message length
  const userMessage = (request.message || '').trim();
  if (userMessage.length === 0) {
    return {
      success: false,
      code: 'INVALID_REQUEST',
      error: 'User message cannot be empty.',
    };
  }
  if (userMessage.length > 2000) {
    return {
      success: false,
      code: 'INVALID_REQUEST',
      error: 'Message exceeds the maximum limit of 2,000 characters.',
    };
  }

  const contextPrepStart = Date.now();

  // Check repeatable request cache (e.g. suggestion chips, room explanations)
  const cacheKey = buildChatCacheKey(request);
  if (cacheKey) {
    const cachedEntry = getCachedChatResponse(cacheKey);
    if (cachedEntry) {
      return {
        success: true,
        cached: true,
        replies: cachedEntry.response.replies,
        workflowDiagram: cachedEntry.response.workflowDiagram,
        providerUsed: cachedEntry.providerUsed,
        provider: cachedEntry.providerUsed,
        timing: {
          ...cachedEntry.timing,
          upstreamMs: 0,
          cached: true,
          totalMs: Date.now() - startTime,
        },
      };
    }
  }

  const systemInstruction = buildSystemPrompt(request);
  const contextPrepMs = Date.now() - contextPrepStart;

  // Format conversation history (last 4 turns max)
  const conversationContents: Array<{ role: 'user' | 'model'; text: string }> = [];

  if (Array.isArray(request.history)) {
    const recentHistory = request.history.slice(-4);
    for (const h of recentHistory) {
      conversationContents.push({
        role: h.role === 'user' ? 'user' : 'model',
        text: h.text,
      });
    }
  }

  // Add current turn
  conversationContents.push({
    role: 'user',
    text: userMessage,
  });

  const includeDiagram = isDiagramIntentRequested(request);
  const chatResponseSchema = getChatResponseSchema(includeDiagram, request.isFragmentRequest);

  const outcome = await executeAiWithFallback(
    {
      systemInstruction,
      messages: conversationContents,
      temperature: request.isFragmentRequest ? 0.35 : 0.7,
      maxOutputTokens: request.isFragmentRequest ? 500 : undefined,
      responseSchema: chatResponseSchema,
      feature: 'chat',
      overallTimeoutMs: 20000,
      perProviderTimeoutMs: 10000,
    },
    env,
    fetchFn
  );

  if (!outcome.success) {
    return {
      success: false,
      code: outcome.code,
      error: outcome.error,
      errorInfo: outcome.errorInfo,
    };
  }

  const validationStart = Date.now();
  let replies: CompanionReplyMessage[];
  let reply: CompanionReplyMessage | undefined;
  let isComplete: boolean | undefined;
  let nextSpeaker: 'dog' | 'cat' | null | undefined;
  let workflowDiagram: WorkflowDiagram | undefined;
  let parseWarning: string | undefined;

  try {
    const validated = parseAndValidateChatResponse(outcome.rawText, request.repoContext);
    replies = validated.replies;
    reply = validated.reply || validated.replies[0];
    isComplete = validated.isComplete;
    nextSpeaker = validated.nextSpeaker;
    workflowDiagram = validated.workflowDiagram;
  } catch (parseErr: unknown) {
    const msg = parseErr instanceof Error ? parseErr.message : 'Invalid response format';
    // Graceful fallback for plain-text model responses without inventing dialogue
    const fallbackSpeaker = request.targetSpeaker || 'dog';
    replies = [
      {
        speaker: fallbackSpeaker,
        text: outcome.rawText.slice(0, 300),
      },
    ];
    reply = replies[0];
    parseWarning = `Warning: ${msg}`;
  }

  const validationMs = Date.now() - validationStart;
  const totalMs = Date.now() - startTime;

  const timing = {
    contextPrepMs,
    upstreamMs: outcome.upstreamMs,
    validationMs,
    fallbackMs: outcome.fallbackMs || 0,
    totalMs,
    promptTokens: outcome.promptTokens,
    candidatesTokens: outcome.candidatesTokens,
    totalTokens: outcome.totalTokens,
    thinkingLevel: outcome.thinkingLevel,
    finishReason: outcome.finishReason,
    providerUsed: outcome.providerUsed,
    provider: outcome.providerUsed,
    fallbackUsed: outcome.providerUsed !== 'gemini',
  };

  // Cache only successfully parsed and fully validated responses (never malformed output, and not single fragments)
  if (cacheKey && !request.isFragmentRequest && !parseWarning) {
    setCachedChatResponse(cacheKey, {
      response: {
        replies,
        workflowDiagram,
      },
      timing,
      providerUsed: outcome.providerUsed,
    });
  }

  return {
    success: true,
    replies,
    reply: reply || replies[0],
    isComplete,
    nextSpeaker,
    workflowDiagram,
    providerUsed: outcome.providerUsed,
    provider: outcome.providerUsed,
    fallbackUsed: outcome.providerUsed !== 'gemini',
    error: parseWarning,
    timing,
  };
}
