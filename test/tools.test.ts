import { describe, expect, it } from 'vitest';
import { evalArithmetic } from '../src/tools.js';

describe('evalArithmetic', () => {
  describe('valid expressions', () => {
    it.each([
      ['2 + 2', 4],
      ['(8 * 4) / 2', 16],
      ['1 + 2 * 3', 7],
      ['(1 + 2) * 3', 9],
      ['-5 + 3', -2],
      ['10 / 4', 2.5],
      ['1.5 * 2', 3],
      ['-(1 + 2)', -3],
      ['  7  ', 7],
      ['2 - -3', 5],
      ['+5', 5],
      ['((1 + 2) * (3 + 4))', 21],
    ])('evaluates %s = %s', (expr, expected) => {
      expect(evalArithmetic(expr)).toBeCloseTo(expected);
    });
  });

  describe('rejects adversarial input', () => {
    it.each([
      'alert(1)',
      'Function("x")()',
      'console.log(1)',
      'process.exit(1)',
      'a + b',
      '',
      '   ',
      '2 ** 3',     // exponent not supported
      '5 % 2',      // modulo not supported
      '1 + ',
      ') + 1',
      '(1 + 2',
      '1 2',        // digits separated by whitespace
      '1 . 5',      // decimal split by whitespace
    ])('throws on %s', (expr) => {
      expect(() => evalArithmetic(expr)).toThrow();
    });

    it('rejects divide-by-zero', () => {
      expect(() => evalArithmetic('1 / 0')).toThrow(/division by zero/i);
    });

    it('rejects trailing garbage', () => {
      expect(() => evalArithmetic('1 + 2; alert(1)')).toThrow();
    });
  });
});
