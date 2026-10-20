export default function handler(event) {
  if (event.type !== 'agent' || event.action !== 'bootstrap') return;
  const context = event.context;
  if (!Array.isArray(context?.bootstrapFiles)) return;
  const allowed = new Set(['AGENTS.md', 'SOUL.md', 'IDENTITY.md']);
  context.bootstrapFiles = context.bootstrapFiles.filter(file => allowed.has(file.name));
  const instructions = context.bootstrapFiles.find(file => file.name === 'AGENTS.md');
  if (instructions && !instructions.missing) {
    instructions.content = `${instructions.content ?? ''}\n\nYour Brain agent identity is snapclaw. Use raw/snapclaw/ for current-session records and skills/save-session/SKILL.md for saving. Shared knowledge comes from wiki/.`;
  }
}
