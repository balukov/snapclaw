# Brain startup policy

Install this directory at `/data/.openclaw/hooks/brain-context/` and enable it with `openclaw hooks enable brain-context`. The managed hook lives on the persistent Railway volume. OpenClaw hot-reloads internal hook configuration.

Required settings, applied on 2026-10-12:

- `plugins.entries.memory-core.config.dreaming.enabled = false`: removes the managed promotion automation instead of letting it recreate itself.
- `agents.defaults.compaction.memoryFlush.enabled = false`: prevents the legacy pre-compaction memory writer.
- `openclaw hooks disable session-memory`: prevents legacy reset-time journal writes.
- Keep the nightly `Brain dreaming` automation (id 31c4ab01, legacy declaration key `jarvis:wrapup`) at 23:00 America/New_York; its message runs `skills/memory-sleep/SKILL.md` as the dreaming role, maintaining wiki and the DREAMS.md diary entry.

Shared Brain instructions and skills arrive through Obsidian Sync. This hook filters automatic context injection and supplies the `snapclaw` identity. It does not enforce filesystem permissions or remove material already present in existing conversations. The separate [Brain access boundary](../../brain-access/README.md) now isolates daytime tools and retains the current session-file association in gateway state.

Check: `node --test test/brain-context.test.mjs`, `openclaw config validate`, `openclaw hooks info brain-context`, and `openclaw automations list --all`.
