/**
 * agent-anthropic.ts
 *
 * PORTED from agent.ts (OpenRouter):
 *   - AgentEvents interface shape (event names and payloads adapted for Anthropic types)
 *   - AgentConfig interface shape (apiKey, model, instructions, maxSteps)
 *   - Class skeleton: messages[], inputHistory[], clearHistory(), setInstructions(),
 *     addTool(), getMessages(), EventEmitter3 extension pattern
 *   - thinking:start / thinking:end lifecycle framing around send()
 *   - error event emission + re-throw pattern
 *   - maxSteps agentic loop guard (default 5)
 *
 * REWRITTEN (not ported):
 *   - Inner streaming loop: uses anthropic.messages.stream() / MessageStream,
 *     not OpenRouter callModel() / getItemsStream()
 *   - Tool execution: explicit agentic loop (while steps < maxSteps) that calls
 *     tool handlers directly and posts tool_result turns — not managed by SDK
 *   - inputHistory shape: Anthropic MessageParam schema with structured tool_use
 *     and tool_result content blocks (not StreamableOutputItem union)
 *   - Tool registration: ToolHandler interface with Anthropic-native definition shape
 *
 * DROPPED (not ported):
 *   - sendSync(): corrupts multi-turn tool call history because it stores the final
 *     text string as an assistant turn instead of the structured content array.
 *     When the model issued a tool_use block, that block must appear in inputHistory
 *     as { type: 'tool_use', id, name, input } so the next turn's tool_result can
 *     reference the same id. A text summary breaks that reference chain and causes
 *     the Anthropic API to reject the conversation with a validation error.
 *   - item:update event: OpenRouter-specific; Anthropic stream events have different
 *     granularity and don't map to the same concept
 *   - Item deduplication by ID: OpenRouter streams progressive updates for the same
 *     item id; Anthropic's MessageStream does not use this pattern
 *
 * PREREQUISITE:
 *   @anthropic-ai/sdk is NOT in package.json. Before using this module, run:
 *     npm install @anthropic-ai/sdk
 */

import Anthropic from '@anthropic-ai/sdk';
import { EventEmitter } from 'eventemitter3';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Tool handler pairs an Anthropic-native tool definition with its executor.
 *
 * Anthropic tool definitions use `input_schema` (not `inputSchema`), following
 * the JSON Schema object convention. The handler receives the parsed input
 * object and must return a string — the API requires tool_result content to be
 * a string or an array of content blocks; returning a string is the simplest
 * safe form.
 */
export interface ToolHandler {
  definition: Anthropic.Messages.Tool;
  handler: (input: unknown) => Promise<string> | string;
}

export interface AgentEvents {
  'message:user': (message: Message) => void;
  'message:assistant': (message: Message) => void;
  'stream:start': () => void;
  'stream:delta': (delta: string, accumulated: string) => void;
  'stream:end': (fullText: string) => void;
  'tool:call': (name: string, args: unknown) => void;
  'tool:result': (toolUseId: string, result: string) => void;
  'error': (error: Error) => void;
  'thinking:start': () => void;
  'thinking:end': () => void;
}

export interface AgentConfig {
  apiKey: string;
  model?: string;
  instructions?: string;
  tools?: ToolHandler[];
  maxSteps?: number;
}

// ---------------------------------------------------------------------------
// Dual-history rationale (critical for multi-turn tool use correctness)
// ---------------------------------------------------------------------------
//
// messages[]       UI display layer — role + plain text only, for rendering.
//                  Contains only user turns and the final assistant text.
//
// inputHistory[]   SDK context layer — full Anthropic MessageParam objects.
//                  MUST contain tool_use blocks as structured objects:
//                    { type: 'tool_use', id, name, input }
//                  AND tool_result turns as structured user messages:
//                    { role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }
//
//                  Storing a text summary instead of the structured tool_use block
//                  breaks the id reference chain. The Anthropic API validates that
//                  every tool_result.tool_use_id matches a tool_use block in the
//                  preceding assistant turn and will reject the request if it does not.

// ---------------------------------------------------------------------------
// Agent class
// ---------------------------------------------------------------------------

export class AnthropicAgent extends EventEmitter<AgentEvents> {
  private client: Anthropic;
  private messages: Message[] = [];
  private inputHistory: Anthropic.Messages.MessageParam[] = [];
  private toolHandlers: Map<string, ToolHandler> = new Map();
  private config: {
    apiKey: string;
    model: string;
    instructions: string;
    maxSteps: number;
  };

  constructor(config: AgentConfig) {
    super();
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.config = {
      apiKey: config.apiKey,
      model: config.model ?? 'claude-sonnet-4-5',
      instructions: config.instructions ?? 'You are a helpful assistant.',
      maxSteps: config.maxSteps ?? 5,
    };
    for (const tool of config.tools ?? []) {
      this.toolHandlers.set(tool.definition.name, tool);
    }
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

  addTool(tool: ToolHandler): void {
    this.toolHandlers.set(tool.definition.name, tool);
  }

  private getToolDefinitions(): Anthropic.Messages.Tool[] {
    return Array.from(this.toolHandlers.values()).map((t) => t.definition);
  }

  /**
   * Send a user message and run the agentic loop until:
   *   - The model returns stop_reason 'end_turn' (no pending tool calls), or
   *   - maxSteps is reached (prevents runaway loops)
   *
   * Returns the final assistant text.
   */
  async send(content: string): Promise<string> {
    const userMessage: Message = { role: 'user', content };
    this.messages.push(userMessage);
    this.inputHistory.push({ role: 'user', content });
    this.emit('message:user', userMessage);
    this.emit('thinking:start');

    let fullText = '';
    let steps = 0;

    try {
      while (steps < this.config.maxSteps) {
        steps++;
        const tools = this.getToolDefinitions();

        // Stream one model turn. Each iteration of this loop is one full
        // request/response cycle; tool execution happens between iterations.
        const stream = this.client.messages.stream({
          model: this.config.model,
          system: this.config.instructions,
          messages: this.inputHistory,
          max_tokens: 8096,
          ...(tools.length > 0 ? { tools } : {}),
        });

        if (steps === 1) {
          this.emit('stream:start');
        }

        let turnText = '';

        // Stream text deltas as they arrive
        stream.on('text', (text) => {
          turnText += text;
          this.emit('stream:delta', text, turnText);
        });

        // Wait for the complete structured message (includes tool_use blocks)
        const finalMessage = await stream.finalMessage();

        // Persist this assistant turn to inputHistory with full structured content.
        // The content array may contain both text and tool_use blocks; we store
        // the whole array so tool_use ids are available for tool_result matching.
        this.inputHistory.push({
          role: 'assistant',
          content: finalMessage.content,
        });

        if (finalMessage.stop_reason === 'end_turn' || finalMessage.stop_reason === 'max_tokens') {
          // No tool calls — conversation turn is complete
          fullText = turnText;
          break;
        }

        if (finalMessage.stop_reason === 'tool_use') {
          // Collect all tool_use blocks from this turn
          const toolUseBlocks = finalMessage.content.filter(
            (block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use',
          );

          if (toolUseBlocks.length === 0) {
            // Unexpected: stop_reason is tool_use but no blocks found — treat as end_turn
            fullText = turnText;
            break;
          }

          // Execute all tool calls and build the tool_result turn.
          // The Anthropic API expects a single user message containing all
          // tool_result blocks for this round, not one message per result.
          const toolResultContents: Anthropic.Messages.ToolResultBlockParam[] = [];

          for (const block of toolUseBlocks) {
            this.emit('tool:call', block.name, block.input);

            let resultContent: string;
            const handler = this.toolHandlers.get(block.name);

            if (!handler) {
              resultContent = `Error: unknown tool "${block.name}"`;
              const err = new Error(resultContent);
              this.emit('error', err);
            } else {
              try {
                resultContent = await handler.handler(block.input);
              } catch (err) {
                resultContent = `Error executing tool "${block.name}": ${err instanceof Error ? err.message : String(err)}`;
                this.emit('error', err instanceof Error ? err : new Error(resultContent));
                // Continue: push the error string as the tool_result so the model
                // can recover or report the failure to the user, rather than aborting
                // the entire conversation.
              }
            }

            this.emit('tool:result', block.id, resultContent!);
            toolResultContents.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: resultContent!,
            });
          }

          // Append the tool_result turn to inputHistory. This is a user-role
          // message as required by the Anthropic API schema.
          this.inputHistory.push({
            role: 'user',
            content: toolResultContents,
          });

          // Loop: the next iteration streams the model's response to the tool results
          continue;
        }

        // Unknown stop_reason — treat as done
        fullText = turnText;
        break;
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
}

export function createAnthropicAgent(config: AgentConfig): AnthropicAgent {
  return new AnthropicAgent(config);
}
