import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { createMessageCatalog, uiText, uiLanguages } from '@cardbush/platform/i18n';
import { buildUiLanguagePacks } from './build-ui-language-packs.mjs';
import { build } from 'vite';
const directory = new URL('../src/i18n/locales/', import.meta.url);
const packs = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.json'))
  .map(name => readFile(new URL(name, directory), 'utf8').then(JSON.parse)));
const catalog = createMessageCatalog(packs);
const defaults = packs.find(pack => pack.locale === 'en');
const variables = message => [...new Set((typeof message === 'string' ? [message] : Object.values(message))
  .flatMap(text => [...text.matchAll(/\{\{|\}\}|\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].flatMap(match => match[1] ? [match[1]] : [])))].sort();

test('shipped language packs have matching keys, nonempty text and matching interpolation variables', () => {
  for (const pack of packs) {
    assert.ok(pack.name.trim());
    assert.deepEqual(Object.keys(pack.messages).sort(), Object.keys(defaults.messages).sort(), pack.locale);
    for (const [key, message] of Object.entries(pack.messages)) {
      if (typeof message !== 'string') assert.equal(typeof message.other, 'string', `${pack.locale}/${key} needs other`);
      for (const text of typeof message === 'string' ? [message] : Object.values(message)) assert.ok(text.trim(), `${pack.locale}/${key}`);
      assert.deepEqual(variables(message), variables(defaults.messages[key]), `${pack.locale}/${key}`);
      const values = Object.fromEntries(variables(message).map(name => [name, name === 'count' ? 2 : 'literal {name} <value>']));
      if (typeof message !== 'string') values.count = 2;
      assert.equal(typeof catalog.text(pack.locale, key, values), 'string', `${pack.locale}/${key}`);
    }
  }
});

test('locale variants resolve to packs and unknown locales fall back to English', () => {
  assert.equal(catalog.text('zh-Hans-CN', 'queue.title'), '引导队列');
  assert.equal(catalog.text('en-GB', 'queue.title'), 'Guidance queue');
  assert.equal(catalog.text('fr', 'queue.title'), 'Guidance queue');
  assert.equal(catalog.text('invalid_locale', 'queue.title'), 'Guidance queue');
  assert.equal(catalog.text('zh', 'queue.send', { index: 2 }), '发送第 2 条引导');
  assert.equal(catalog.text('en', 'queue.send', { index: 2 }), 'Send queue item 2');
});

test('a third data-only pack supports plural rules, regional fallback and missing-message fallback', () => {
  const third = { locale: 'ru', name: 'Русский', messages: {
    'queue.title': 'Очередь',
    'queue.viewImages': { one: '{count} изображение', few: '{count} изображения', many: '{count} изображений', other: '{count} изображения' },
  } };
  const extended = createMessageCatalog([...packs, third]);
  assert.equal(extended.text('ru-RU', 'queue.title'), 'Очередь');
  for (const [count, expected] of [[1, '1 изображение'], [2, '2 изображения'], [5, '5 изображений']]) {
    assert.equal(extended.text('ru', 'queue.viewImages', { count }), expected);
  }
  assert.equal(extended.text('ru', 'image.loading'), 'Loading image…');
  assert.ok(extended.languages.some(pack => pack.locale === 'ru' && pack.name === 'Русский'));
  assert.equal(extended.list('ru', ['a.png', 'b.png']), new Intl.ListFormat('ru', { style: 'short', type: 'conjunction' }).format(['a.png', 'b.png']));
});

test('interpolation is literal, nonrecursive and rejects incomplete contracts', () => {
  const name = '<img onerror=alert(1)> {count} $&';
  assert.equal(catalog.text('en', 'image.preview', { name }), `Image preview: ${name}`);
  assert.throws(() => catalog.text('en', 'image.preview'), /Missing UI message variable/);
  assert.throws(() => catalog.text('en', 'queue.viewImages', { count: '2' }), /numeric count/);
  assert.throws(() => catalog.text('en', 'queue.viewImages', { count: NaN }), /numeric count/);
  assert.throws(() => catalog.text('en', 'unknown.key'), /Unknown UI message/);
  assert.throws(() => catalog.text('en', '__proto__'), /Unknown UI message/);
  assert.throws(() => createMessageCatalog([...packs, defaults]), /Duplicate language pack/);
  assert.throws(() => createMessageCatalog(packs.filter(pack => pack.locale !== 'en')), /Missing default/);
  const literal = createMessageCatalog([{ locale: 'en', name: 'English', messages: { example: '{{name}}: {name}' } }]);
  assert.equal(literal.text('en', 'example', { name: '$& {nested}' }), '{name}: $& {nested}');
});

test('the complete App keeps translated literals and conditional appearance values out of components', async () => {
  const files = (await readdir('src', { recursive: true })).filter(file => /\.(?:ts|tsx)$/.test(file)
    && !file.replaceAll('\\', '/').startsWith('i18n/') && !file.replaceAll('\\', '/').startsWith('features/pre_test/')).map(file => path.join('src', file));
  files.push('electron/main.ts', 'electron/fileContextMenu.ts', 'electron/localApplications.ts', 'electron/windowsApplicationShortcuts.ts');
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const location = node => `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
    const walk = node => {
      if (ts.isJsxAttribute(node) && node.name.getText(source) === 'size' && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        assert.ok(!ts.isConditionalExpression(node.initializer.expression), `${location(node)}: icon size variants belong in CSS variables`);
      }
      if (ts.isPropertyAssignment(node) && ['visibility', 'translate'].includes(node.name.getText(source))) {
        let owner = node.parent;
        while (owner && !ts.isJsxAttribute(owner) && !ts.isVariableDeclaration(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
        if (owner && ((ts.isJsxAttribute(owner) && owner.name.getText(source) === 'style')
          || (ts.isVariableDeclaration(owner) && owner.type?.getText(source).includes('CSSProperties')))) {
          assert.ok(!ts.isConditionalExpression(node.initializer), `${location(node)}: presentation state belongs in CSS`);
        }
      }
      if (ts.isJsxText(node)) assert.doesNotMatch(node.text, /\p{L}/u, `${location(node)}: move UI text into a language pack`);
      if (ts.isJsxAttribute(node) && /^(?:title|label|subtitle|description|placeholder|aria-label|aria-description|alt|hint|emptyText|text)$/.test(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer)) {
        assert.equal(node.initializer.text, '', `${location(node)}: move the accessible label or placeholder into a language pack`);
      }
      if (ts.isConditionalExpression(node) && /\b(?:language|uiLanguage|zh|isZh)\b/.test(node.condition.getText(source))
        && /(?:===?|!==?)\s*['"](?:zh|en)['"]|^zh$|^uiLanguage$/.test(node.condition.getText(source))) {
        assert.ok(![node.whenTrue, node.whenFalse].some(branch => ts.isStringLiteral(branch) || ts.isTemplateExpression(branch)), `${location(node)}: locale branches belong in the catalog`);
      }
      if (ts.isCallExpression(node) && ts.isCallExpression(node.expression) && ['uiText', 'nativeText'].includes(node.expression.expression.getText(source))
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const key = node.arguments[0].text, message = defaults.messages[key];
        assert.ok(message !== undefined, `${location(node)}: unknown key ${key}`);
        const expected = variables(message);
        if (typeof message !== 'string' && !expected.includes('count')) expected.push('count');
        const args = node.arguments[1];
        if (!args || ts.isObjectLiteralExpression(args)) {
          const supplied = args?.properties.map(property => property.name?.getText(source).replaceAll("'", '').replaceAll('"', '')) ?? [];
          for (const variable of expected) assert.ok(supplied.includes(variable), `${location(node)}: missing ${key}.${variable}`);
        }
      }
      if (ts.isIfStatement(node) && /^(?:language|uiLanguage)\s*===?\s*['"](?:zh|en)['"]$/.test(node.expression.getText(source).trim())) {
        assert.fail(`${location(node)}: language-specific UI branches belong in the catalog`);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
});

test('adding a JSON language pack is discovered by the real builder without editing a registry', async () => {
  await mkdir('tmp', { recursive: true });
  const root = await mkdtemp(path.resolve('tmp/ui-language-build-'));
  try {
    const directory = pathToFileURL(root + path.sep), target = new URL('generatedMessages.ts', directory);
    await writeFile(new URL('en.json', directory), JSON.stringify({ locale: 'en', name: 'English', messages: { hello: 'Hello {name}', files: { one: '{count} file', other: '{count} files' } } }));
    await writeFile(new URL('fr.json', directory), JSON.stringify({ locale: 'fr', name: 'Français', messages: { hello: 'Bonjour {name}' } }));
    assert.deepEqual(await buildUiLanguagePacks({ directory, target }), { locales: ['en', 'fr'], messageCount: 2 });
    const built = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false,
      lib: { entry: fileURLToPath(target), formats: ['cjs'] } } });
    const result = (Array.isArray(built) ? built : [built]).flatMap(item => item.output).find(item => item.type === 'chunk' && item.isEntry);
    const module = { exports: {} };
    new Function('module', 'exports', result.code)(module, module.exports);
    const generated = module.exports;
    const assembled = createMessageCatalog([...generated.languagePacks]);
    assert.equal(assembled.text('fr-CA', 'hello', { name: 'Ada' }), 'Bonjour Ada');
    assert.equal(assembled.text('fr', 'files', { count: 2 }), '2 files');
    assert.deepEqual(assembled.languages.map(pack => pack.name), ['English', 'Français']);
    await writeFile(new URL('fr.json', directory), JSON.stringify({ locale: 'fr', name: 'Français', messages: { hello: 'Bonjour {wrong}' } }));
    await assert.rejects(buildUiLanguagePacks({ directory, target }), /variables differ/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('renderer and native consumers share the generated catalog', async () => {
  assert.deepEqual(uiLanguages, catalog.languages);
  assert.equal(uiText('zh-CN')('common.close'), catalog.text('zh', 'common.close'));
  const { createRequire } = await import('node:module');
  const native = createRequire(import.meta.url)('@cardbush/platform/i18n');
  assert.equal(native.uiText('en')('queue.title'), uiText('en')('queue.title'));
});

test('native menus follow the App language, normalize locale tags and reject other senders', async () => {
  const file = 'electron/main.ts';
  const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const functions = ['nativeText', 'updateTrayMenu'].map(name => {
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration, name);
    return declaration.getText(source);
  });
  const registration = source.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(source) === 'ipcMain.handle' && node.expression.arguments[0]?.text === 'app:set-ui-language');
  assert.ok(registration);
  let handler;
  const menus = [];
  const bindings = { uiText, resolveUiLanguage: catalog.resolve,
    app: { isReady: () => true, getLocale: () => 'en-GB' },
    Menu: { buildFromTemplate: template => template }, tray: { setContextMenu: menu => menus.push(menu) },
    showMainWindow: () => {}, requestAppQuit: () => {},
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    assertMainWindowSender: id => { if (id !== 7) throw Error('Untrusted sender'); },
  };
  const code = 'let nativeUiLanguage;\n' + functions.join('\n') + '\n' + registration.getText(source) + '\nupdateTrayMenu();';
  new Function(...Object.keys(bindings), ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(bindings));
  const labels = () => menus.at(-1).filter(item => item.label).map(item => item.label);
  assert.deepEqual(labels(), ['Open cardbush', 'Quit']);
  handler({ sender: { id: 7 } }, 'zh-CN');
  assert.deepEqual(labels(), ['打开 cardbush', '退出']);
  const count = menus.length;
  handler({ sender: { id: 7 } }, 'zh');
  assert.equal(menus.length, count, 'same resolved language does not rebuild the menu');
  assert.throws(() => handler({ sender: { id: 8 } }, 'en'), /Untrusted sender/);
  assert.deepEqual(labels(), ['打开 cardbush', '退出']);
  handler({ sender: { id: 7 } }, 'en-US');
  assert.deepEqual(labels(), ['Open cardbush', 'Quit']);
  handler({ sender: { id: 7 } }, { invalid: 'locale' });
  assert.deepEqual(labels(), ['Open cardbush', 'Quit']);
});
