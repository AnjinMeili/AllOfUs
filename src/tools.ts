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

/**
 * Parse and evaluate an arithmetic expression with + - * / and parentheses.
 * No identifiers, no function calls, no property access — just numbers and
 * the five binary ops. Safer than `Function()` / `eval()`.
 *
 * Exported for tests.
 */
export function evalArithmetic(expression: string): number {
  const s = expression;
  let i = 0;

  const skipSpace = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const peek = () => { skipSpace(); return s[i]; };
  const eat = (c: string) => { skipSpace(); if (s[i] === c) { i++; return true; } return false; };

  // Numbers are the only token where whitespace is NOT skipped mid-token —
  // so "1 2" correctly parses "1" then fails at the stray "2".
  const parseNumber = (): number => {
    skipSpace();
    const start = i;
    while (i < s.length && /[0-9]/.test(s[i])) i++;
    if (s[i] === '.') {
      i++;
      while (i < s.length && /[0-9]/.test(s[i])) i++;
    }
    if (i === start) throw new Error(`Expected number at position ${i}`);
    const n = Number(s.slice(start, i));
    if (!Number.isFinite(n)) throw new Error(`Invalid number: ${s.slice(start, i)}`);
    return n;
  };

  const parseFactor = (): number => {
    if (eat('(')) {
      const v = parseExpr();
      if (!eat(')')) throw new Error(`Expected ')' at position ${i}`);
      return v;
    }
    if (eat('-')) return -parseFactor();
    if (eat('+')) return parseFactor();
    return parseNumber();
  };

  const parseTerm = (): number => {
    let left = parseFactor();
    while (peek() === '*' || peek() === '/') {
      const op = peek(); i++;
      const right = parseFactor();
      if (op === '/') {
        if (right === 0) throw new Error('Division by zero');
        left = left / right;
      } else {
        left = left * right;
      }
    }
    return left;
  };

  function parseExpr(): number {
    let left = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = peek(); i++;
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  skipSpace();
  if (i >= s.length) throw new Error('Empty expression');
  const result = parseExpr();
  skipSpace();
  if (i !== s.length) throw new Error(`Unexpected character '${s[i]}' at position ${i}`);
  if (!Number.isFinite(result)) throw new Error('Non-finite result');
  return result;
}

export const calculatorTool = tool({
  name: 'calculate',
  description: 'Perform arithmetic with + - * / and parentheses',
  inputSchema: z.object({
    expression: z.string().describe('Math expression (for example, 2 + 2, (8 * 4) / 2)'),
  }),
  execute: async ({ expression }) => {
    const result = evalArithmetic(expression);
    return { expression, result };
  },
});

export const defaultTools = [timeTool, calculatorTool];
