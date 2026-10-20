import { createStore } from './store.mjs';

export default {
  id: 'brain-access', name: 'Brain access',
  register(api) {
    const store = createStore(api.pluginConfig.vault, api.pluginConfig.state);
    const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
    api.registerTool(ctx => {
      if (ctx.agentId !== 'main') return null;
      return [
        { name: 'brain_wiki', label: 'Read Brain wiki',
          description: 'Read a wiki Markdown page. Start with index.md. No raw or legacy memory access.',
          parameters: { type: 'object', additionalProperties: false, properties: { page: { type: 'string' } } },
          execute: async (_id, args) => result(store.wiki(args.page)) },
        { name: 'brain_session', label: 'Save current Brain session',
          description: 'After a meaningful decision/result, start a goal by title, read its current note, then save the merged Markdown body (sections Согласовано, Сделано, Открыто, Следующий шаг; no frontmatter) with the returned revision; set status paused or done only when the owner switches or confirms. The host retains this goal across restarts. Start a different title only when the owner switches goals. Never choose a path or read old notes.',
          parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
            action: { type: 'string', enum: ['start', 'read', 'save'] }, title: { type: 'string', maxLength: 200 },
            body: { type: 'string', maxLength: 40000 }, revision: { type: 'string' },
            status: { type: 'string', enum: ['active', 'paused', 'done'] } } },
          execute: async (_id, args) => result(store.session(ctx.sessionKey, args)) },
      ];
    }, { names: ['brain_wiki', 'brain_session'] });
  },
};
