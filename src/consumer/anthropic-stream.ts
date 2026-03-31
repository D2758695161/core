import { nanoid } from 'nanoid';

export interface OpenAIChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
    };
    finish_reason: string | null;
  }>;
}

export function makeChunk(
  id: string,
  model: string,
  created: number,
  delta: { role?: string; content?: string },
  finishReason: string | null,
): string {
  const chunk: OpenAIChunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function makeDone(): string {
  return 'data: [DONE]\n\n';
}
