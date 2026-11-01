import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// aihub-web mounts /firmware from this directory and loads the module on demand.
// It decides whether the flashing panel is usable by the global below, and feeds
// it the manifest through the aihub:firmware event, so both must stay.
const source = await readFile(new URL('../flash/echoear-installer.js',import.meta.url),'utf8');

test('the module announces itself to the console after binding its panel', () => {
  const declared = source.indexOf('window.AIHubFlasher=');
  assert.ok(declared > 0,'the console shows no panel without this global');
  assert.ok(declared > source.lastIndexOf("$('echoear-heard').onclick"),
    'the global must only appear once every panel handler is bound');
});

test('the module still listens for the manifest the console sends', () => {
  assert.match(source,/addEventListener\('aihub:firmware'/);
});

test('the panel ids it binds stay prefixed into the console page', () => {
  const ids = [...source.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map(match => match[1]);
  assert.ok(ids.length > 0);
  assert.deepEqual(ids.filter(id => !id.startsWith('echoear-')),[]);
});
