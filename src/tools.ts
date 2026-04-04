import { tool } from '@openrouter/sdk/lib/tool.js';
import { z } from 'zod';

export const timeTool = tool({
  name: 'get_current_time',
  description: 'Get the current date and time',
  inputSchema: z.object({
    timezone: z.string().optional().describe('Timezone (for example, UTC or America/New_York)'),
  }),
  execute: async ({ timezone }) => {
    const tz = timezone || 'UTC';
    return {
      time: new Date().toLocaleString('en-US', { timeZone: tz }),
      timezone: tz,
    };
  },
});

export const calculatorTool = tool({
  name: 'calculate',
  description: 'Perform mathematical calculations',
  inputSchema: z.object({
    expression: z.string().describe('Math expression (for example, 2 + 2, (8 * 4) / 2)'),
  }),
  execute: async ({ expression }) => {
    const sanitized = expression.replace(/[^0-9+\-*/().\s]/g, '');
    if (!sanitized.trim()) {
      throw new Error('Expression contained no valid math tokens.');
    }

    const result = Function(`"use strict"; return (${sanitized})`)();
    return { expression, result };
  },
});

export const defaultTools = [timeTool, calculatorTool];
