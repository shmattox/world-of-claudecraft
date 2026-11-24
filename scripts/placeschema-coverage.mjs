// Report how the authored WoC item catalogs enter the game's PlaceSchema type mapping.
// Run from any directory: node scripts/placeschema-coverage.mjs [--stdout].
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentRoot = path.join(root, 'src/sim/content');
const reportPath = path.join(root, 'docs/placeschema-catalog-coverage.md');

function itemFiles(dir = contentRoot) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return itemFiles(full);
      return entry.isFile() && entry.name.endsWith('items.ts') ? [full] : [];
    })
    .sort();
}

function isItem(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.kind === 'string'
  );
}

async function catalogAndMapping(files) {
  // Compile the server's actual mapping function, without starting its DB and pollers.
  // If that function gains a dependency, this build fails until the report follows it.
  const serverSource = readFileSync(path.join(root, 'server/placeschema_sidecar.ts'), 'utf8');
  const serverAst = ts.createSourceFile('placeschema_sidecar.ts', serverSource, ts.ScriptTarget.Latest);
  const mapping = serverAst.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'typeFor',
  );
  const bodySlots = serverAst.statements.find(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some((declaration) => declaration.name.getText(serverAst) === 'BODY_SLOTS'),
  );
  if (!mapping || !bodySlots) throw new Error('PlaceSchema typeFor or BODY_SLOTS mapping is missing');
  const imports = files.map((file, index) => {
    const relative = path.relative(root, file).replaceAll('\\', '/');
    return `import * as catalog${index} from './${relative}';`;
  });
  const entry = [
    ...imports,
    "import { ITEMS } from './src/sim/data.ts';",
    "import { weaponTypeForItem } from './src/sim/content/weapon_skin_rules.ts';",
    bodySlots.getText(serverAst),
    mapping.getText(serverAst),
    'export { ITEMS };',
    `export const catalogs = [${files.map((_, index) => `catalog${index}`).join(', ')}];`,
  ].join('\n');
  const build = await esbuild.build({
    stdin: {
      contents: entry,
      resolveDir: root,
      sourcefile: 'placeschema-coverage-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
  });
  const url = `data:text/javascript;base64,${Buffer.from(build.outputFiles[0].text).toString('base64')}`;
  return import(url);
}

function reportFor(files, catalogs, items, typeFor) {
  const byId = new Map();
  for (const [index, catalog] of catalogs.entries()) {
    const source = path.relative(root, files[index]).replaceAll('\\', '/');
    const tables = Object.entries(catalog).filter(([name]) => name.endsWith('_ITEMS'));
    if (tables.length === 0) throw new Error(`${source}: no exported item table found`);
    for (const [name, value] of tables) {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`${source}: ${name} is not an item table`);
      for (const [key, def] of Object.entries(value)) {
        if (!isItem(def)) throw new Error(`${source}: ${name}.${key} is not an item definition`);
        if (key !== def.id) throw new Error(`${source}: catalog key ${key} differs from ${def.id}`);
        const prior = byId.get(def.id);
        if (prior && prior.kind !== def.kind)
          throw new Error(`${def.id}: conflicting kinds in ${prior.source} and ${source}`);
        byId.set(def.id, { kind: def.kind, source });
      }
    }
  }
  if (byId.size === 0) throw new Error('No item definitions found in *items.ts catalogs');

  const rows = new Map();
  const uncovered = [];
  for (const [id, item] of [...byId].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const row = rows.get(item.kind) ?? { total: 0, mapped: 0, refused: 0 };
    row.total++;
    const def = items[id];
    // The server accepts every catalog kind through typeFor, including its misc.<kind>
    // fallback. It has no catalog-class refusal table. Carry refusals in
    // PlaceSchemaCarry are about a grant, holder, save or remote response.
    const mappedType = def && typeFor(def);
    if (def && def.kind === item.kind && typeof mappedType === 'string' && mappedType.trim()) {
      row.mapped++;
    } else {
      uncovered.push(`${id} (${item.kind}, ${item.source})`);
    }
    rows.set(item.kind, row);
  }
  if (uncovered.length)
    throw new Error(`Items with neither a mapping nor a class refusal reason:\n${uncovered.join('\n')}`);

  const lines = [
    '# PlaceSchema catalog coverage',
    '',
    'Regenerate with `node scripts/placeschema-coverage.mjs`. The script reads every `*items.ts` file under `src/sim/content/`, checks each exported `*_ITEMS` table against the live `ITEMS` catalog, and uses the game server\'s `typeFor` mapping.',
    '',
    'A mapped item has a WoC catalog definition and a nonempty PlaceSchema type from `server/placeschema_sidecar.ts`. That server maps every catalog kind, using `misc.<kind>` for kinds without a specialized type. The renderer display fallback in `src/render/characters/woc_item_display.ts` and the offline GUID mint in `src/game/item_guid_mint.ts` do not refuse catalog classes.',
    '',
    '| Item class | Total | Mapped | Refused |',
    '| --- | ---: | ---: | ---: |',
    ...[...rows].sort(([a], [b]) => a.localeCompare(b, 'en')).map(
      ([kind, row]) => `| \`${kind}\` | ${row.total} | ${row.mapped} | ${row.refused} |`,
    ),
    '',
    '## Refused classes',
    '',
    'None. The game has no catalog-class refusal rule. Per-copy and transport refusals in `PlaceSchemaCarry` are outside these class counts.',
    '',
  ];
  return lines.join('\n');
}

const files = itemFiles();
const { catalogs, ITEMS, typeFor } = await catalogAndMapping(files);
const report = reportFor(files, catalogs, ITEMS, typeFor);
if (process.argv[2] === '--stdout') {
  process.stdout.write(report);
} else if (process.argv.length === 2) {
  writeFileSync(reportPath, report);
} else {
  throw new Error('Usage: node scripts/placeschema-coverage.mjs [--stdout]');
}
