import { frozen } from '../../shared/frozen.js';

// The models an owned session may run (orchestra app plan §2 "模型白名单"): only what the local magpie
// gateway serves under zcode/*, opencode-go/* and codex/*. Anything else is refused before a child
// starts. The name after the prefix keeps to a short, plain grammar, so it goes into config.toml and
// thread/start as it is.

export const OWNED_MODEL_PREFIXES = frozen(['zcode/', 'opencode-go/', 'codex/'] as const);
export const OWNED_MODEL_RE = frozen(/^(?:zcode|opencode-go|codex)\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
/** The default for an owned Codex session (orchestra app plan §2). */
export const DEFAULT_CODEX_MODEL = 'codex/gpt-6.1-sol';

export function isOwnedModel(model: unknown): model is string {
  return typeof model === 'string' && OWNED_MODEL_RE.test(model);
}
