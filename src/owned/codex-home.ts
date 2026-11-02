import * as path from 'node:path';
import type { WriteFence } from '../fs/write-fence.ts';
import { frozen } from '../../shared/frozen.js';
import { isOwnedModel } from './models.ts';

const win = path.win32;

// The private CODEX_HOME of the owned Codex sessions (orchestra app plan §2): ORCHESTRA_HOME\codex-home
// in both profiles (the test profile's ORCHESTRA_HOME lies in its test dir), written through the write
// fence at startup. Its config.toml sends every model call to the local magpie gateway and asks before
// anything leaves the workspace; nothing of the user's own ~/.codex is read or copied.
//
// Skills (measured on codex-cli 0.165.0, 2026-11-02): a private CODEX_HOME does not keep codex away from
// the user's own skills. It lists ~/.agents/skills (found through USERPROFILE, not CODEX_HOME) in the
// model's instructions, and in a live run the model asked to Get-Content one of their SKILL.md files.
// [skills] include_instructions = false takes the whole skills list (and its roots) out of the prompt,
// and an explicit "$name" mention then injects nothing either; [skills.bundled] enabled = false keeps
// codex from unpacking its own system skills into the private home. Neither a [[skills.config]] entry
// for the root nor the skip_host_skill_discovery feature took the root out. Whether codex still scans
// the directory itself (reading the files' front matter) is unknown: nothing of it reaches the model.

export const OWNED_DIRS = frozen({ codexHome: 'codex-home', work: 'work' });

/** Only a loopback gateway: an owned session's prompts and files go to this machine and nowhere else. */
export const GATEWAY_RE = frozen(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1$/);

export type CodexConfig = { model: string; gatewayBaseUrl: string };

/** config.toml for the private CODEX_HOME; the values are checked, so none needs escaping. */
export function codexConfigToml(c: CodexConfig): string {
  if (!isOwnedModel(c.model)) throw new Error(`codex home: model outside the owned list: ${String(c.model)}`);
  if (typeof c.gatewayBaseUrl !== 'string' || !GATEWAY_RE.test(c.gatewayBaseUrl)) throw new Error(`codex home: the gateway must be http://127.0.0.1:<port>/v1, got ${String(c.gatewayBaseUrl)}`);
  return [
    `model = "${c.model}"`,
    'model_provider = "magpie"',
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    '',
    '[model_providers.magpie]',
    'name = "magpie"',
    `base_url = "${c.gatewayBaseUrl}"`,
    'wire_api = "responses"',
    '',
    '[skills]',
    'include_instructions = false',
    '',
    '[skills.bundled]',
    'enabled = false',
    '',
  ].join('\n');
}

/** Makes `<home>\codex-home` and writes its config.toml through the fence; returns the dir. */
export function writeCodexHome(fence: Pick<WriteFence, 'mkdirp' | 'writeAtomic'>, home: string, c: CodexConfig): string {
  const dir = win.join(home, OWNED_DIRS.codexHome);
  const toml = codexConfigToml(c);
  fence.mkdirp(dir);
  fence.writeAtomic(win.join(dir, 'config.toml'), toml);
  return dir;
}
