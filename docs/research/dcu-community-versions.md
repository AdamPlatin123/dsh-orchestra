<!-- Raw researcher report: Opus sweep "community-versions", 2026-10-26. Unedited. Synthesized and red-teamed into dsh-computer-use.md; where the two disagree, the synthesized file wins (see its Review log). -->

## Identity & scope

Key: community-versions. This covers adoption, breakage history and version drift for DSH computer use (CU), read as the release engineer. Sources are npm, gh api (GraphQL and REST), the sparse clone at HEAD 22ddee37, and the installed `@deepseek-ai/dsh` 0.2.1-rc.2. Repo paths are relative to the deepseek-harness root unless prefixed. The repo has issues disabled and its public PR endpoints return 404 (`gh api repos/... --jq .has_issues` → false; `pulls` → 404), so I couldn't search issues or PRs. Discussions and commits are the only public trail.

## Facts

1. **The release tags carry no CU code changes after rc.2. The CU work since then is master-only.** `compare/dsh-v0.2.1-rc.2...dsh-v0.2.1-rc.3` shows ahead 6, behind 0. The six commits are UI navigation, analytics, the LLM /models change, the release commit and its merge. Within the CU and browser-use packages the diff touches only `packages/{computer-use,browser-use}/*/package.json` (+1/-1 version bumps). The compare API caps its file list at 300, but the commit list shows the rest is unrelated. The CU commits in that window landed on master only: consent UI 948f411a, 0–999 relative coordinates 7e8bf280/e0b95e3e, launch readiness a275fdd7, optional macOS setup 1954e948 (2026-10-19..22). They come from `gh api commits?path=packages/experimental/cua*`.
2. **`packages/experimental/cua-bundle` (`@deepseek-ai/dsh-cua-bundle`) exists only on master.** The contents API returns 404 for it at both `dsh-v0.2.1-rc.2` and `dsh-v0.2.1-rc.3`, while `cua` and `cua-macos` exist at both tags. npm returns 404 for dsh-cua-bundle, which matches the verified list.
3. **rc.4 was published to npm today with no public tag.** `@deepseek-ai/dsh` 0.2.1-rc.4 is dated 2026-10-26T15:28:13Z, and the CU packages followed at 15:28–15:31Z. `git/refs/tags/dsh-v0.2.1-rc.4` returns 404, and the newest public master commit is 22ddee37 (2026-10-23). The rc.4 builds look identical to rc.2. `npm view …@0.2.1-rc.2` and `…@0.2.1-rc.4` give the same `dist.unpackedSize` and fileCount for each package: dsh-computer-use 14331/10, dsh-cua 165259/19, cua-macos 472983/59, cua-driver-native 28965/9. Inferred: rc.4 carries no CU changes, and the master consent and coordinate work is unpublished.
4. **Why "latest" is stale.** `.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md:35` says DSH publication maps alpha/canary to their own tags, "maps other prereleases including `rc` to `next`", and leaves `latest` to npm's default. In every CU package, `latest` points to the package's first-ever publish:
   - dsh-computer-use, cua-driver-{mcp,native}, dsh-browser-use and the browser-use providers: created 2026-09-15T03:2x, `latest` = 0.1.6-alpha.1.
   - dsh-cua: created 2026-10-14T12:35, `latest` = 0.2.1-alpha.3, published 12:39.
   
   Inferred: npm set `latest` automatically on each first publish and nothing has moved it since. `@deepseek-ai/dsh` `latest` = 0.2.1-rc.2 is the exception; it must have been promoted by hand, and the note doesn't document that. **Consequence: an unpinned `npm i @deepseek-ai/dsh-computer-use` gets the September alpha that broke profile boot in D#6788.** Pin `@next` or an exact version.
5. **Publish cadence.** All CU packages are republished with every DSH prerelease: 17 versions each from 0.1.6-alpha.1 (2026-09-15) to 0.2.1-rc.4 (`npm view … time`). `cua-driver-native` pins `@trycua/cua-driver` exactly at 0.28.0 in both rc.2 and rc.4 (npm `dependencies`).
6. **Landing dates.** `af4ad058` "feat: add computer use with Cua Driver providers" landed 2026-09-12 and first shipped in 0.1.6-alpha.1. The cua-macos primitives arrived in `7417c38a` (2026-09-23, "copy licensed macOS accessibility and input primitives"). PR #4456 `feat/experimental-dsh-cua` was merged 2026-10-14 (`f9c634d0`), and dsh-cua was first published to npm that day. The bundle followed on 2026-10-19 (`1954e948`).
7. **The native Cua Driver provider was removed from the install closure in 0.1.7-rc.2.** Commit `a3480857` (2026-09-24, #4867) dropped "the Playwright MCP, Chrome DevTools MCP, and native Cua Driver bundles" because each "would add about 85 MB of provider runtimes" to every install. The design note `.agents/notes/implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.md:15` says Cua Driver providers "remain explicit compositions". The same note at :21 makes `dsh-cua-bundle` (macOS, own helper) the shipped optional bundle. This explains why the installed rc.2 has no CU packages.
8. **The provider bundle is macOS-only and source-only.** `packages/experimental/cua-bundle/README.md:12` says "Windows support is in development". At :27 the workflow "targets developers running macOS Web or unpackaged Desktop from source". At :40, on other operating systems "installation omits the optional macOS provider". In `cordis.patch.yml:6` the cua-macos row has `disabled: !!js process.platform !== 'darwin'`. `packages/experimental/cua/README.md:112-114` covers Windows: it is planned as "a separate provider package with a C# helper". The package stays experimental until then. No C# helper commit appears in the cua* commit logs on master.
9. **The cua-driver-native provider does work on Windows. This corrects the design note's "no Tier 2 driver" assumption for Windows.** Five Windows reports and one Linux report, from 0.1.6 to 0.2.1:
   - D#8927 (2026-10-05, Desktop 0.1.7-alpha.2, Windows 11): `CuaDriver.create()` + `listToolsJson` → "OK — 56 tools", and `cua_driver_sdk.dll` (~25 MB) is present.
   - D#6788, comment by DDDFXYqiming (2026-09-30): adding the 0.2.0-rc.2 packages to a Desktop profile makes the `cua_driver_native__*` tools appear. In that comment's words, "health_report 的五项核心检查全过，UIA 树遍历和 Windows Graphics Capture 都能用" (all five core health_report checks pass; UIA tree walks and Windows Graphics Capture both work).
   - D#6780 (Windows 11, 0.1.6-alpha.1): UIA token invoke works, and a WinUI Notepad ValuePattern write was confirmed.
   - D#7788 (Windows 11, 0.1.7-rc.2): the provider was used on Windows.
   - D#11018 (2026-10-25, rc.3): the provider installs on Linux/Hyprland, but foreground input needs a compositor plugin that the npm package doesn't install.
10. **D#7788 and D#6780 (structuredContent dropped from what the model sees) are NOT fixed on master or in rc.2.**
    - `packages/mcp/mcp-client/src/tools.ts:261-263`: `render()` returns only `extractText(result.content, rawName)`. The last commit to this file is `ab102138` (2026-09-21).
    - Installed rc.2 `dsh-mcp-client/lib/index.js:214-217` is identical.
    - `packages/experimental/computer-use-cua-driver-native/src/index.ts:37` still tells the model "Use element_token from that snapshot". The token lives only in `structuredContent`, which never reaches the model.
    - The D#6780 Linux follow-up shows the action contract rejects the only handle the model can see ("bare element_index is not accepted").
    - Neither thread has a maintainer reply or an accepted answer.
    - Inferred, not verified: PTC/`run_code` callers get the canonical `{content, structuredContent}`. That would bypass the gap, but cua-driver-native has no PTC mode.
11. **D#6788 (bundle-less CU packages broke profile boot in 0.1.6-alpha.1) is half-fixed.** The plugin manager now refuses to append bundle-less packages: master `packages/boot/plugin-manager/src/operations.ts:96-104` warns "declares no dsh.bundle — installed as a plain dependency" and skips the `bundles` append. Installed rc.2 has the same code at `dsh-plugin-manager/lib/index.js:336`. The loader is still strict: rc.2 `dsh-app-boot/lib/index.js:1024` still throws on a listed bundle with no manifest, so legacy profiles still break. The CU packages still ship with no `dsh` key (`npm view @deepseek-ai/dsh-computer-use@0.2.1-rc.4 --json` has no `dsh` field). I couldn't identify the fixing commit; `747c98b0` (2026-09-23, "deny incompatible bundles…") is a candidate (not verified).
12. **D#8927: the shipped "standard" preset's computer-use group never started (Windows Desktop 0.1.7-alpha.2).** It got no maintainer reply. Public `packages/bundle/web-app/presets/standard.patch.yml` history (2026-09-10..10-10) has no diff line mentioning computer or cua. A code search for the native provider finds no preset file referencing it, and installed rc.2 `dsh-web-app/presets/standard.patch.yml` has no CU rows (grep). Inferred: the Desktop build carried its own composition, and the group disappeared once the optional-bundle change in fact 7 took effect. I found no root-cause fix.
13. **How a user on npm-latest rc.2 gets the official stack.** The documented path is an explicit composition:
    - Install the packages: `dsh plugin add` installs them as plain dependencies with a warning (`docs/user/develop/basic/publish.md:64`).
    - Insert the rows `@deepseek-ai/dsh-computer-use` + `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native` in `$DSH_HOME/profiles/<p>/cordis.patch.yml` or a `--patch` overlay (`computer-use-cua-driver-native/README.md:28-35`; layer order `docs/architecture.md:25`).
    - The rc.2 local market index has no CU entry (grep of installed `dsh-plugin-market-index` finds nothing). I didn't check the remote market.
    - Pin versions: npm `latest` resolves to 0.1.6-alpha.1 (fact 4).
14. **The third-party republishes are whole-fork rebrands, not CU patches.**
    - `@qlzt/dsh-experimental-computer-use-cua-driver-mcp` 0.2.1-rc.2 (`next` 0.2.2-rc.1): maintainer laraveladmin.cn, repo gitee.com/zsping1989/deepseek-harness, depends on `@qlzt/dsh-mcp-client`.
    - `@qilin-agent/experimental-computer-use-cua-driver-mcp` 3.1.7: repo github.com/kkutysllb/QiLin; the scope republishes the whole core (`@qilin-agent/agent`, `tools`, `session` … all 3.1.7, `npm search qilin-agent`).
    - Sizes are near the original (22 KB / 21.5 KB vs 28.9 KB native). Inferred: these are mirror/forks of the whole monorepo.
15. **Community Windows CU plugins exist, and the most-starred one is ahead of the official stack on Windows.** Data is from `gh search repos "dsh computer use"`, `gh api repos/...` and npm.
    - **Yu-tao-Li/dsh-computer-use-win**: 229★, pushed 2026-10-25, releases v0.4.2→v0.5.2 (10-18..10-25). npm `dsh-computer-use-win` 0.5.2 declares `dsh.bundle.patch` and peers `@deepseek-ai/dsh-mcp-client`. Install: `dsh plugin --profile desktop add dsh-computer-use-win` (README:37). It wraps a resident PowerShell UIA backend over MCP, with requests queued one at a time "两个操作不会同时抢鼠标和键盘" (two operations never fight over the mouse and keyboard; README:169). It prefers UIA invoke/set_value in the background (README:250). It borrows the foreground only for coordinate clicks, keystrokes and paste, then gives focus back, with a `POINT_COVERED` check (README:203, 285). Esc stops the run, and a separate takeover process draws an on-screen banner. Web pages go to a separate, isolated CDP browser (README:266).
    - **@copylee/dsh-computer-use** 0.8.0: C# helper compiled locally with the system csc.exe plus DSH's bundled koffi, per-app authorization; needs DSH ≥ 0.2.0-rc.2 (README:40, 52).
    - **LJL454/dsh-computer-use** 1.40.3: tested on Desktop 0.2.1-rc.3 and npm 0.2.1-rc.2, with `dsh.compatibility` per-release evidence (README:99-119); not on npm.
    - **Han-1413141/dsh-codex-computer-use** 0.1.4: drives the locally installed Codex `@oai/sky` from a child worker. It has its own consent window and a per-session app grant, and needs DSH 0.2.0-rc.2 (README:3-15, 77-81, 126). The README warns the sky elicitation callback "不是稳定的第三方扩展规范" (is not a stable third-party extension spec).
    - Older or abandoned: Altairpaca (D#1561, PS/OCR, pushed 09-03), linxsy-code (D#5959, `--patch` from a checkout), qphotoai, secretxuan, was11121, xiaoheizi1212.
16. **The community macOS plugins differ from the official stack.**
    - D#3868 AzaiSakura: a Swift AX daemon over a peer-authenticated Unix socket (getpeereid), 10 native tools, approval through `ctx.approval`. It predates official CU by 3 weeks (2026-08-21 vs af4ad058 2026-09-12).
    - D#10741 OrderG-X: vision-first (OCR + set-of-mark numbering), no accessibility tree.
    - D#10997 dshapp: a thin MCP bridge to an external KimiCU.app that owns the macOS permissions. It claims background input without moving the cursor and asks before irreversible actions.
    - Anionex/dsh-computer-use (73★, pushed 2026-10-26) is macOS-only.
17. **The official Cua route has a history of unanswered usability bugs.**
    - D#6778: 15 s snapshot TTL, mixed px/pt coordinates, `effect: unverifiable`.
    - D#7080: 55 tools always registered, about 23.5k prefix tokens per request, no opt-out (`Config = Schema.object({})`).
    - D#6780: DPI awareness has to be set in the embedding Node host.
    - D#11018: install and `health_report ok` don't mean input works.
    - Browser-side breakages from the same window: D#6956 (playwright-mcp hang blocks session creation, 0.1.6-alpha.1, Windows) and D#7857 (attach-mode exclusive slot held by desktop session seeding, 0.1.7-rc.2).

## Patterns for Orchestra

- **Pin exact versions and treat npm `latest` as meaningless for DSH CU packages** (facts 3, 4). Record the DSH core version and CU package versions per Musician. Upstream rc builds can be byte-identical across tags, and the public repo can lag npm.
- **Don't route model-facing CU handles through DSH's MCP adapter** (fact 10). If Orchestra talks to cua-driver directly, read `structuredContent` itself. Never rely on DSH rendering it for a DSH-hosted Musician.
- **Adopt Yu-tao-Li's single-lane queue and borrow-then-return foreground pattern as the shape of a Tier 2 Lease** (fact 15). Queue all desktop input through one serialized executor. Prefer background UIA. Borrow the foreground per step with occlusion checks and return it afterwards. Show a visible takeover banner, and give the human a kill switch (Esc) outside the agent loop. This matches the design note's human-granted desktop Lease, except that in Orchestra the Lease would be the human grant itself.
- **Copy the consent shapes** (facts 15, 16): session-scoped, per-application grants held in memory (dsh-codex-computer-use, dsh-cua) and an external app that owns the permissions (KimiCU). These line up with the Grant entity in the design note.
- **Avoid in-process native drivers in the host that owns the Post Office.** cua-driver-native crashes can kill the host (verified list), and D#6780 needs host-level DPI awareness. Run the driver in a child process, as dsh-codex-computer-use, Yu-tao-Li and cua-driver-mcp do.
- **Avoid assuming exclusivity from DSH** (facts 9, 17; verified list). Nothing in DSH, official or community, coordinates several sessions on one desktop beyond per-plugin queues. Orchestra must own the Lease.
- **Expect large tool catalogs and budget for the prefix cost** (D#7080, 55 tools ≈23.5k tokens).

## Verdict

On 2026-10-26, the realistic way for a Windows user on dsh rc.2 to get computer use into a DSH session is a community bundle: `dsh plugin --profile <p> add dsh-computer-use-win` (npm 0.5.2, a valid `dsh.bundle`, released 2026-10-25) or `@copylee/dsh-computer-use`. The official alternative is composing `dsh-computer-use` + `dsh-experimental-computer-use-cua-driver-native@0.2.1-rc.2` (pinned, not `latest`) into the profile patch by hand. The official native route does run on Windows (UIA and WGC confirmed in D#6788, D#6780, D#8927). It has been broken by packaging regressions in every minor version, the structuredContent gap is unfixed, there's no maintainer response, and the official Windows provider (C# helper) doesn't exist yet. The macOS-only `dsh-cua-bundle` is unpublished and master-only. Stability is low: community plugins iterate daily and ship with no version guarantees, and the official stack is "experimental, no stability promise" (`computer-use-cua-driver-native/README.md:134`). Orchestra should treat any DSH-side computer use as an untrusted, version-pinned, per-Musician add-on and keep the desktop Lease and serialization in Orchestra itself.

## Open questions

- Is D#7788 fixed in the unpublished rc.4 source? The identical unpackedSize of the mcp-client sibling packages suggests not, but I didn't diff `dsh-mcp-client@0.2.1-rc.4`.
- Which commit removed the computer-use group from the Desktop "standard" preset (D#8927)? The public history shows none, so the Desktop composition may be private.
- Does the remote plugin market list dsh-computer-use-win or the official CU packages? The Yu-tao-Li README claims it is searchable in the market (not verified).
- Does the cua-driver 0.28.0 Windows binary refuse background input to elevated or UIPI-protected windows the same way the Yu-tao-Li README describes (`background_uipi_blocked`)?
- When will the C# Windows provider land? There is no public branch, commit or discussion.

## Sources

- npm: `npm view @deepseek-ai/{dsh,dsh-computer-use,dsh-cua,dsh-experimental-cua-macos,dsh-experimental-computer-use-cua-driver-{mcp,native},dsh-browser-use,dsh-experimental-browser-use-{runtime,playwright-mcp}} dist-tags time`; `…@0.2.1-rc.{2,4} dist.unpackedSize dependencies`; `npm pack --dry-run @deepseek-ai/dsh-experimental-cua-macos@0.2.1-rc.4`; `npm view @qlzt/…`, `@qilin-agent/…`, `dsh-computer-use-win`, `@copylee/dsh-computer-use`.
- GitHub API:
  - tags; `git/refs/tags/dsh-v0.2.1-rc.4` (404); `compare/dsh-v0.2.1-rc.2...dsh-v0.2.1-rc.3`; `contents/packages/experimental/{cua,cua-macos,cua-bundle}?ref=…`
  - `commits?path=packages/computer-use|packages/experimental/cua*|computer-use-cua-driver-*|packages/mcp/mcp-client/src/tools.ts|packages/bundle/web-app/presets/standard.patch.yml`; commit `a3480857`
- GraphQL discussion search; Discussions #1561 #2162 #3868 #4001 #5856 #5959 #6778 #6780 #6788 #7080 #7788 #8458 #8625 #8927 #10741 #10997 #11018 (and the titles of #6956 and #7857).
- Repos: Yu-tao-Li/dsh-computer-use-win, LJL454/dsh-computer-use, copylee711/dsh-computer-use, Han-1413141/dsh-codex-computer-use, Anionex/dsh-computer-use, AzaiSakura/dsh-computer-use, OrderG-X/dsh-mac-computer-use, dshapp/dsh-kimi-computer-use, Altairpaca/dsh-computer-use-windows, linxsy-code/dsh-plugin-window-input.
- Clone files:
  - `packages/mcp/mcp-client/src/tools.ts:261-263`
  - `packages/experimental/computer-use-cua-driver-native/src/index.ts:37-39`
  - `packages/experimental/computer-use-cua-driver-native/README.md:12,28-35,43,127-134`
  - `packages/experimental/cua-bundle/{README.md:12,27,40; cordis.patch.yml:1-10; package.json}`
  - `packages/experimental/cua/README.md:112-114`
  - `.agents/notes/implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.md:15,21,27`
  - `.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md:35`
  - `docs/user/develop/basic/publish.md:64`; `docs/architecture.md:25`
  - `packages/boot/plugin-manager/src/operations.ts:96-104` (via contents API)
- Installed rc.2 files under `C:/Users/Calx/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`:
  - `dsh-mcp-client/lib/index.js:214-217`
  - `dsh-plugin-manager/lib/index.js:336`
  - `dsh-app-boot/lib/index.js:1024`
  - `dsh-web-app/presets/standard.patch.yml`
- Scratch (raw discussion JSON, READMEs): `C:/Users/Calx/AppData/Local/Temp/claude/G---Projects-dsh-orchestra/9a172ed9-e9ae-47dd-b3c0-dc5700f0828c/scratchpad/dcu/community-versions/`
