import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function read(path) {
  return readFileSync(path, 'utf8');
}

function readJson(path) {
  return JSON.parse(read(path));
}

test('package metadata bundles rpiv ask_user_question extension', () => {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const packageName = '@juicesharp/rpiv-ask-user-question';
  const extensionPath = './node_modules/@juicesharp/rpiv-ask-user-question/index.ts';

  assert.equal(pkg.dependencies[packageName], '^1.0.14');
  assert.ok(pkg.bundledDependencies.includes(packageName));
  assert.ok(pkg.pi.extensions.includes(extensionPath));

  assert.equal(lock.packages[''].dependencies[packageName], '^1.0.14');
  assert.ok(lock.packages[''].bundleDependencies.includes(packageName));
  assert.ok(lock.packages['node_modules/@juicesharp/rpiv-ask-user-question']);
});

test('arc extension delegates ask_user_question to bundled package', () => {
  const source = read('extensions/arc.ts');

  assert.doesNotMatch(source, /name:\s*["']ask_user_question["']/);
  assert.doesNotMatch(source, /AskUserQuestion/);
  assert.doesNotMatch(source, /DynamicBorder/);
  assert.doesNotMatch(source, /SelectList/);
  assert.doesNotMatch(source, /SelectItem/);
  assert.doesNotMatch(source, /Container/);
  assert.match(source, /name:\s*["']arc_agent["']/);
});

test('docs teach rpiv ask_user_question schema and escape hatches', () => {
  const readme = read('README.md');
  const brainstorm = read('skills/arc-brainstorm/SKILL.md');
  const plan = read('skills/arc-plan/SKILL.md');
  const sourceSync = read('skills/arc-source-sync/SKILL.md');
  const migrate = read('scripts/migrate-arc-plugin.py');

  for (const source of [readme, brainstorm, plan, sourceSync, migrate]) {
    assert.match(source, /questions\[\]/);
  }

  for (const source of [readme, brainstorm, sourceSync]) {
    assert.match(source, /@juicesharp\/rpiv-ask-user-question/);
    assert.match(source, /Type something\./);
    assert.match(source, /Chat about this/);
    assert.match(source, /\(Recommended\)/);
  }

  for (const source of [brainstorm, plan]) {
    assert.doesNotMatch(source, /^Question:\s*"/m);
    assert.doesNotMatch(source, /^Options:/m);
  }
});
