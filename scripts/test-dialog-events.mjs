import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

test('every native dialog scopes its cancel and close callbacks to the owning dialog', () => {
  const files = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith('.tsx')) files.push(file);
    }
  };
  walk('src');
  let checked = 0;
  for (const file of files) {
    const parsed = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = node => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(parsed) === 'dialog') {
        for (const property of node.attributes.properties) {
          if (!ts.isJsxAttribute(property) || !['onCancel', 'onClose'].includes(property.name.text)) continue;
          const expression = property.initializer?.expression;
          assert.ok(expression && ts.isCallExpression(expression) && expression.expression.getText(parsed) === 'dialogEventHandler',
            `${file}: ${property.name.text} must ignore child picker/dialog events`);
          checked++;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  assert.ok(checked >= 15, 'cover the production dialogs, including nested application and plugin panels');
});
