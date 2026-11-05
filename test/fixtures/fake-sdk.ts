// A scriptable stand-in for the Agent SDK's query() (alpha 0.2 design §6), for driving
// hosts/claude/host-core.mjs without claude.exe. A test plays the CLI: it emits stream messages, reads
// the user messages the host streamed in, and runs tool calls through the host's PreToolUse hook and
// canUseTool the way the CLI 2.1.310 does under settingSources: [] and permissionMode 'default'
// (probe REPORT §10 item 2): the hook first; 'deny' stops the call; 'ask' goes to canUseTool; no
// decision lets the CLI's default run, which calls canUseTool for writing tools and runs Read, Glob and
// Grep by itself.

export type Msg = Record<string, unknown>;
export type HookOutput = { hookSpecificOutput?: { hookEventName: string; permissionDecision?: string; permissionDecisionReason?: string } };
export type PermissionResult = { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown } | { behavior: 'deny'; message: string };
export type ToolCall = {
  hook: HookOutput;
  /** 'deny' | 'ask' | 'default': what the hook decided ('default' when it returned no decision). */
  decision: string;
  /** canUseTool's answer when the call reached it; null when it did not. */
  permission: Promise<PermissionResult> | null;
  /** Aborts the signal canUseTool was handed (the CLI gave up on the call). */
  abort(): void;
};

type Options = Record<string, any>;

/** The tools the CLI runs by itself when the hook gives no decision (probe §10 item 2). */
const RUNS_BY_DEFAULT = ['Read', 'Glob', 'Grep'];

export class FakeQuery {
  readonly options: Options;
  /** The user messages the host streamed in, in order. */
  readonly received: Msg[] = [];
  interrupts = 0;
  closed = false;
  /** What interrupt() resolves to; an Error makes it reject. */
  interruptReply: unknown = { still_queued: [] };
  private queue: Msg[] = [];
  private ended = false;
  private failure: unknown = null;
  private wake: (() => void) | null = null;
  private userWaiters: (() => void)[] = [];

  constructor(prompt: AsyncIterable<Msg>, options: Options) {
    this.options = options;
    void (async () => {
      for await (const m of prompt) {
        this.received.push(m);
        for (const w of this.userWaiters.splice(0)) w();
      }
    })();
  }

  /** The CLI writes a stream message. */
  emit(m: Msg): void {
    this.queue.push(m);
    this.wake?.();
  }

  /** The CLI's stream ends by itself. */
  end(): void {
    this.ended = true;
    this.wake?.();
  }

  /** The CLI's stream throws. */
  fail(e: unknown): void {
    this.failure = e;
    this.wake?.();
  }

  interrupt(): Promise<unknown> {
    this.interrupts++;
    const r = this.interruptReply;
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }

  close(): void {
    this.closed = true;
    this.end();
  }

  /** Resolves once the host has streamed in at least `n` user messages. */
  async users(n: number): Promise<Msg[]> {
    while (this.received.length < n) await new Promise<void>((r) => this.userWaiters.push(r));
    return this.received;
  }

  /** One tool call, the way the CLI makes it; `agentId` when a sub-agent makes it (measured: the hook's agent_id, canUseTool's agentID). */
  async callTool(name: string, input: Record<string, unknown>, toolUseId: string, agentId?: string): Promise<ToolCall> {
    const controller = new AbortController();
    let hook: HookOutput = {};
    for (const matcher of this.options.hooks?.PreToolUse ?? []) {
      for (const fn of matcher.hooks) {
        hook = await fn({ hook_event_name: 'PreToolUse', session_id: 'fake', transcript_path: '', cwd: this.options.cwd, tool_name: name, tool_input: input, tool_use_id: toolUseId, ...(agentId === undefined ? {} : { agent_id: agentId, agent_type: 'general-purpose' }) }, toolUseId, { signal: controller.signal });
      }
    }
    const decision = hook.hookSpecificOutput?.permissionDecision ?? 'default';
    const reaches = decision === 'ask' || (decision === 'default' && !RUNS_BY_DEFAULT.includes(name));
    const permission = reaches ? this.options.canUseTool(name, input, { signal: controller.signal, toolUseID: toolUseId, suggestions: [{ type: 'addRules' }], ...(agentId === undefined ? {} : { agentID: agentId }) }) : null;
    return { hook, decision, permission, abort: () => controller.abort() };
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Msg> {
    for (;;) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.failure !== null) throw this.failure;
      if (this.ended) return;
      await new Promise<void>((r) => {
        this.wake = r;
      });
      this.wake = null;
    }
  }
}

/** A fake SDK module: `query` records every query it makes. */
export function makeFakeSdk(): { query: (p: { prompt: AsyncIterable<Msg>; options: Options }) => FakeQuery; queries: FakeQuery[] } {
  const queries: FakeQuery[] = [];
  return {
    queries,
    query: ({ prompt, options }) => {
      const q = new FakeQuery(prompt, options);
      queries.push(q);
      return q;
    },
  };
}

/** A system/init message that passes every startup check, with `over` laid on top. */
export function initMessage(over: Msg = {}): Msg {
  return {
    type: 'system',
    subtype: 'init',
    session_id: '11111111-2222-4333-8444-555555555555',
    claude_code_version: '2.1.287',
    model: 'opencode-go/claude-haiku-5-5',
    permissionMode: 'default',
    tools: ['Edit', 'Glob', 'Grep', 'PowerShell', 'Read', 'Write'],
    mcp_servers: [],
    skills: ['dataviz', 'loop', 'run'],
    plugins: [{ name: 'cc-plugin-agents-md', path: 'x' }, { name: 'cc-plugin-telemetry', path: 'y' }],
    ...over,
  };
}
