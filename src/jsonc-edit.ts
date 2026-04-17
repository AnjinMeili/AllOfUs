import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';

export interface PlannedEdit {
  jsonPath: (string | number)[];
  newValue: unknown;
  description: string;
}

export interface EditResult {
  description: string;
  before: unknown;
  after: unknown;
}

export interface TextPlan {
  oldText: string;
  newText: string;
  edits: EditResult[];
}

function getAtPath(obj: unknown, path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const segment of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[segment];
  }
  return cur;
}

function valueEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Apply a set of JSONC edits to a text buffer. Uses jsonc-parser's
 * modify/applyEdits pipeline, which preserves comments, trailing commas,
 * and existing formatting. Skips edits whose before == after, so
 * already-correct files aren't modified.
 *
 * Pure function over strings — no filesystem access.
 */
export function planJsoncEdits(oldText: string, edits: PlannedEdit[]): TextPlan {
  const seedText = oldText.length > 0 ? oldText : '{}\n';
  let newText = seedText;
  const parsed = (parseJsonc(seedText) as unknown) ?? {};
  const changes: EditResult[] = [];

  for (const edit of edits) {
    const before = getAtPath(parsed, edit.jsonPath);
    if (valueEq(before, edit.newValue)) continue;

    const editList = modify(newText, edit.jsonPath, edit.newValue, {
      formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' },
    });
    newText = applyEdits(newText, editList);
    changes.push({ description: edit.description, before, after: edit.newValue });
  }

  return { oldText, newText, edits: changes };
}
