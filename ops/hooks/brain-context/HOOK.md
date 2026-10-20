---
name: brain-context
description: Keep Brain startup context limited to instructions and agent identity.
metadata:
  { "openclaw": { "events": ["agent:bootstrap"] } }
---

# Brain context

Keep legacy knowledge out of startup injection. Shared knowledge is read from wiki on demand; current-session notes are managed by save-session. This filters bootstrap context, not filesystem access.
