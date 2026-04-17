import { OpenRouter } from '@openrouter/sdk';
import { stepCountIs } from '@openrouter/sdk/lib/stop-conditions.js';
import type { StreamableOutputItem } from '@openrouter/sdk/lib/stream-transformers.js';
import type { Tool } from '@openrouter/sdk/lib/tool-types.js';
import { EventEmitter } from 'eventemitter3';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AgentEvents {
  'message:user': (message: Message) => void;
  'message:assistant': (message: Message) => void;
  'item:update': (item: StreamableOutputItem) => void;
  'stream:start': () => void;
  'stream:delta': (delta: string, accumulated: string) => void;
  'stream:end': (fullText: string) => void;
  'tool:call': (name: string, args: unknown) => void;
  'tool:result': (nameOrCallId: string, result: unknown) => void;
  'reasoning:update': (text: string) => void;
  'error': (error: Error) => void;
  'thinking:start': () => void;
  'thinking:end': () => void;
}

export interface AgentConfig {
  apiKey: string;
  model?: string;
  instructions?: string;
  tools?: Tool[];
  maxSteps?: number;
}

/**
 * An entry in the history we send back to the model on subsequent turns.
 * The SDK's `InputsUnion` array accepts both simple user messages
 * (`{role, content}` shape) and the typed stream items produced in
 * previous turns (function calls, function-call outputs, reasoning, etc.).
 * We keep the union loose here because the SDK's concrete union lives at
 * a deep path; a narrower type would require pinning internal imports.
 */
type InputItem =
  | { role: 'user' | 'assistant' | 'system'; content: string }
  | StreamableOutputItem;

export class Agent extends EventEmitter<AgentEvents> {
  private client: OpenRouter;
  private messages: Message[] = [];
  /**
   * The full turn-by-turn history we pass to the SDK as `input`. Unlike
   * `messages` (which is just role + reconstructed text for UI display),
   * this preserves the actual stream items from previous turns — tool
   * calls, tool results, and reasoning — so the model sees the complete
   * conversation on the next call.
   */
  private inputHistory: InputItem[] = [];
  private config: Required<Omit<AgentConfig, 'apiKey'>> & { apiKey: string };

  constructor(config: AgentConfig) {
    super();
    this.client = new OpenRouter({ apiKey: config.apiKey });
    this.config = {
      apiKey: config.apiKey,
      model: config.model ?? 'openrouter/auto',
      instructions: config.instructions ?? 'You are a helpful assistant.',
      tools: [...(config.tools ?? [])],
      maxSteps: config.maxSteps ?? 5,
    };
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  clearHistory(): void {
    this.messages = [];
    this.inputHistory = [];
  }

  setInstructions(instructions: string): void {
    this.config.instructions = instructions;
  }

  addTool(newTool: Tool): void {
    this.config.tools.push(newTool);
  }

  async send(content: string): Promise<string> {
    const userMessage: Message = { role: 'user', content };
    this.messages.push(userMessage);
    this.inputHistory.push({ role: 'user', content });
    this.emit('message:user', userMessage);
    this.emit('thinking:start');

    try {
      const result = this.client.callModel({
        model: this.config.model,
        instructions: this.config.instructions,
        input: this.inputHistory as never,
        tools: this.config.tools.length > 0 ? this.config.tools : undefined,
        stopWhen: [stepCountIs(this.config.maxSteps)],
      });

      this.emit('stream:start');
      let fullText = '';
      // Dedupe stream items by id: the SDK emits progressive updates for
      // the same id; the last version wins. This Map preserves insertion
      // order, so when we drain it into inputHistory the turn's items are
      // appended in the order they started streaming.
      const turnItems = new Map<string, StreamableOutputItem>();

      for await (const item of result.getItemsStream()) {
        this.emit('item:update', item);
        const id = ('id' in item && typeof item.id === 'string' && item.id)
          ? item.id
          : `${item.type}:${turnItems.size}`;
        turnItems.set(id, item);

        switch (item.type) {
          case 'message': {
            const textContent = item.content?.find((c: { type: string }) => c.type === 'output_text');
            if (textContent && 'text' in textContent) {
              const nextText = String(textContent.text);
              if (nextText !== fullText) {
                const delta = nextText.slice(fullText.length);
                fullText = nextText;
                this.emit('stream:delta', delta, fullText);
              }
            }
            break;
          }
          case 'function_call': {
            if (item.status === 'completed') {
              let args: unknown = {};
              try {
                args = JSON.parse(item.arguments || '{}');
              } catch {
                args = item.arguments || '{}';
              }
              this.emit('tool:call', item.name, args);
            }
            break;
          }
          case 'function_call_output': {
            const callId = 'callId' in item ? String(item.callId) : 'unknown';
            this.emit('tool:result', callId, item.output);
            break;
          }
          case 'reasoning': {
            const reasoningText = item.content?.find((c: { type: string }) => c.type === 'reasoning_text');
            if (reasoningText && 'text' in reasoningText) {
              this.emit('reasoning:update', String(reasoningText.text));
            }
            break;
          }
          default:
            break;
        }
      }

      // Persist this turn's items so the next call sees the full context
      // (tool calls + their outputs + reasoning), not just the final text.
      for (const persisted of turnItems.values()) {
        this.inputHistory.push(persisted);
      }

      if (!fullText) {
        fullText = await result.getText();
      }

      this.emit('stream:end', fullText);

      const assistantMessage: Message = { role: 'assistant', content: fullText };
      this.messages.push(assistantMessage);
      this.emit('message:assistant', assistantMessage);

      return fullText;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', error);
      throw error;
    } finally {
      this.emit('thinking:end');
    }
  }

  async sendSync(content: string): Promise<string> {
    const userMessage: Message = { role: 'user', content };
    this.messages.push(userMessage);
    this.inputHistory.push({ role: 'user', content });
    this.emit('message:user', userMessage);
    this.emit('thinking:start');

    try {
      const result = this.client.callModel({
        model: this.config.model,
        instructions: this.config.instructions,
        input: this.inputHistory as never,
        tools: this.config.tools.length > 0 ? this.config.tools : undefined,
        stopWhen: [stepCountIs(this.config.maxSteps)],
      });

      const fullText = await result.getText();
      // sendSync bypasses the item stream so tool calls/results aren't
      // individually captured. Storing the text as an assistant turn
      // keeps the role sequence valid for subsequent calls, but
      // multi-turn tool use works better through send().
      const assistantMessage: Message = { role: 'assistant', content: fullText };
      this.messages.push(assistantMessage);
      this.inputHistory.push({ role: 'assistant', content: fullText });
      this.emit('message:assistant', assistantMessage);

      return fullText;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', error);
      throw error;
    } finally {
      this.emit('thinking:end');
    }
  }
}

export function createAgent(config: AgentConfig): Agent {
  return new Agent(config);
}
