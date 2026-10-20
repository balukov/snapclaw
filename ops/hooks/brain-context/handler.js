export default function handler(event) {
  if (event.type !== 'agent' || event.action !== 'bootstrap') return;
  const context = event.context;
  if (!Array.isArray(context?.bootstrapFiles)) return;
  const allowed = new Set(['AGENTS.md', 'SOUL.md', 'IDENTITY.md']);
  context.bootstrapFiles = context.bootstrapFiles.filter(file => allowed.has(file.name));
}
