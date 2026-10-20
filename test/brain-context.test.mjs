import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../ops/hooks/brain-context/handler.js';
test('bootstrap keeps only instructions and identity files', () => {
  const event = {type: 'agent', action: 'bootstrap', context: {bootstrapFiles: ['AGENTS.md','SOUL.md','IDENTITY.md','USER.md','MEMORY.md','memory/today.md','raw/other/note.md'].map(name => ({name, content:name, missing:false}))}};
  handler(event);
  assert.deepEqual(event.context.bootstrapFiles.map(f=>f.name),['AGENTS.md','SOUL.md','IDENTITY.md']);
});
test('unrelated events and absent bootstrap files are untouched', () => {
  const event={type:'message',action:'received',context:{bootstrapFiles:[{name:'USER.md'}]}};
  handler(event);
  assert.equal(event.context.bootstrapFiles.length,1);
  handler({type:'agent',action:'bootstrap',context:{}});
});
