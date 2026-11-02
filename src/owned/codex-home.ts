import * as path from 'node:path';
import type { WriteFence } from '../fs/write-fence.ts';
import { frozen } from '../../shared/frozen.js';
import { isOwnedModel } from './models.ts';

const win = path.win32;

// The private CODEX_HOME of the owned Codex sessions (orchestra app plan §2): ORCHESTRA_HOME\codex-home
// in both profiles (the test profile's ORCHESTRA_HOME lies in its test dir), written through the write
// fence at startup. Its config.toml sends every model call to the local magpie gateway and asks before
// anything leaves the workspace; nothing of the user's own ~/.codex is read or copied.

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
