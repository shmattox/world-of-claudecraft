import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('PlaceSchema catalog coverage', () => {
  it('maps or explains every authored item class and keeps the committed report current', () => {
    // The generator throws when an item has neither a live mapping nor a class refusal.
    const actual = execFileSync(
      process.execPath,
      [path.join(root, 'scripts/placeschema-coverage.mjs'), '--stdout'],
      { cwd: root, encoding: 'utf8' },
    );
    const committed = readFileSync(path.join(root, 'docs/placeschema-catalog-coverage.md'), 'utf8');
    expect(committed).toBe(actual);

    const rows = [...actual.matchAll(/^\| `([^`]+)` \| (\d+) \| (\d+) \| (\d+) \|$/gm)];
    expect(rows.length).toBeGreaterThan(0);
    for (const [, itemClass, total, mapped, refused] of rows) {
      expect(Number(mapped) + Number(refused), itemClass).toBe(Number(total));
      if (Number(refused) > 0) {
        const reason = actual
          .split('\n')
          .find((line) => line.startsWith(`- \`${itemClass}\`: `))
          ?.split(': ')[1]
          ?.trim();
        expect(reason, `${itemClass} needs a refusal reason`).toBeTruthy();
      }
    }
  });
});
