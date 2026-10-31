import { ACK_PHASES, PERMISSIONS, SEVERITIES, VISIBILITIES } from '../../shared/protocol.js';

// The notify channel's whole interface (plan step 3, frozen here; step 5 implements it with a fake
// ToastPort, step 17 brings the real one). The channel routes an item that is due a notification to
// exactly one browser stream (the most recently visible notifiable one, else the newest), or to the
// toast when no client can take it; takes the page's acks (D-15: a dispatched ack with no error inside
// the attempt's 1.5 s window, measured on the Clock, sets notifiedAt through one journal record; shown
// goes to the metric side table only; error turns to the toast at once and marks the stream); keeps
// each tab's client state; and tells the toast worker how many clients are online (10 idle minutes
// and it closes). Delivery is at least once, the itemId is the tag (P5).
//
// A notifiable client: its stream is open, it is not frozen, its permission is granted and its stream
// is not marked ack-failed. The mark is cleared by a visible, unfrozen client state from that tab or by
// the stream reconnecting (UI design 一 6).
//
// Nothing here carries source free text: a title is {key, args} (shared/protocol.js titleError), a
// project is its id, display name and hue, and the one text is a reminder's own words, as body.

export type Visibility = (typeof VISIBILITIES)[number];
export type Permission = (typeof PERMISSIONS)[number];
export type AckPhase = (typeof ACK_PHASES)[number];
export type Severity = (typeof SEVERITIES)[number];

/** A title as frames carry it: a key of shared/protocol.js TITLE_KEYS and its checked args. */
export type Title = { readonly key: string; readonly args: Readonly<Record<string, string>> };
/** A project as frames carry it (UI design 一 2). */
export type ProjectView = { readonly id: string; readonly name: string; readonly hue: number };

/** What the channel is handed for an item due a notification. body is the reminder's own text, null for every other kind. */
export type NotifyItem = { readonly itemId: string; readonly sev: Severity; readonly title: Title; readonly project: ProjectView | null; readonly body: string | null };

/** POST /api/notify-ack, as channel.ack() takes it. */
export type Ack = { readonly itemId: string; readonly attempt: number; readonly tabId: string; readonly phase: AckPhase };

/** What an ack did: the first dispatched of an attempt is recorded, a later one is a duplicate, an attempt the channel never made is stale. */
export type AckReply = 'recorded' | 'dup' | 'stale';

/** POST /api/client-state without its perf samples (those go to the metric table, not the channel). */
export type ClientState = { readonly tabId: string; readonly visibility: Visibility; readonly frozen: boolean; readonly permission: Permission };

/** The notify frame (UI design 一 1): sent to one stream only, always after the snapshot it depends on. */
export type NotifyFrame = { readonly itemId: string; readonly attempt: number; readonly sev: Severity; readonly title: Title; readonly project: ProjectView | null };

export interface NotifyChannel {
  /** An item is due a notification: route it to one stream, or to the toast. */
  notify(item: NotifyItem): void;
  ack(ack: Ack): AckReply;
  clientState(state: ClientState): void;
  streamOpened(tabId: string): void;
  streamClosed(tabId: string): void;
  /** How many notifiable clients there are now. */
  onlineClients(): number;
}

/** One live stream as the SSE server lists it. openedMono is the Clock's nowMono() at its open. */
export type StreamInfo = { readonly tabId: string; readonly openedMono: number; readonly visible: boolean; readonly frozen: boolean; readonly dirty: boolean };

/** What the channel needs of the SSE server (step 4). */
export interface StreamsPort {
  /** The live streams, in the order they were opened. */
  liveStreams(): readonly StreamInfo[];
  /** Queues a notify frame on one stream (behind its pending snapshot when the stream is dirty). */
  sendNotify(tabId: string, frame: NotifyFrame): void;
}

export type ToastShow = { readonly itemId: string; readonly attempt: number; readonly title: Title; readonly body: string | null };

/** What the channel needs of the toast worker (step 17; a fake in step 5). shownMono is the Clock's nowMono() when the worker reported shown. */
export interface ToastPort {
  show(toast: ToastShow): void;
  onShown(cb: (itemId: string, attempt: number, shownMono: number) => void): void;
}

// The interface as data, for the contract-freeze test and for wiring: TypeScript types vanish at run
// time, these lists do not.
export const CHANNEL_METHODS = Object.freeze(['notify', 'ack', 'clientState', 'streamOpened', 'streamClosed', 'onlineClients'] as const satisfies readonly (keyof NotifyChannel)[]);
export const STREAMS_PORT_METHODS = Object.freeze(['liveStreams', 'sendNotify'] as const satisfies readonly (keyof StreamsPort)[]);
export const TOAST_PORT_METHODS = Object.freeze(['show', 'onShown'] as const satisfies readonly (keyof ToastPort)[]);
export const ACK_FIELDS = Object.freeze(['itemId', 'attempt', 'tabId', 'phase'] as const satisfies readonly (keyof Ack)[]);
export const ACK_REPLIES = Object.freeze(['recorded', 'dup', 'stale'] as const satisfies readonly AckReply[]);
export const CLIENT_STATE_FIELDS = Object.freeze(['tabId', 'visibility', 'frozen', 'permission'] as const satisfies readonly (keyof ClientState)[]);
export const STREAM_INFO_FIELDS = Object.freeze(['tabId', 'openedMono', 'visible', 'frozen', 'dirty'] as const satisfies readonly (keyof StreamInfo)[]);
export const NOTIFY_ITEM_FIELDS = Object.freeze(['itemId', 'sev', 'title', 'project', 'body'] as const satisfies readonly (keyof NotifyItem)[]);
export const NOTIFY_FRAME_FIELDS = Object.freeze(['itemId', 'attempt', 'sev', 'title', 'project'] as const satisfies readonly (keyof NotifyFrame)[]);
export const TOAST_SHOW_FIELDS = Object.freeze(['itemId', 'attempt', 'title', 'body'] as const satisfies readonly (keyof ToastShow)[]);

/**
 * The first method `port` lacks, or null: each name must lead to a function on the object or on a
 * prototype of its own, never on Object.prototype (where any module could have put one). A wiring
 * root checks every port it hands the channel with this and fails closed.
 */
export function missingMethod(port: unknown, methods: readonly string[]): string | null {
  if (typeof port !== 'object' || port === null) return methods[0] ?? null;
  for (const m of methods) {
    let found = false;
    for (let o: object | null = port; o !== null && o !== Object.prototype; o = Object.getPrototypeOf(o) as object | null) {
      const d = Object.getOwnPropertyDescriptor(o, m);
      if (d === undefined) continue;
      found = 'value' in d && typeof d.value === 'function';
      break;
    }
    if (!found) return m;
  }
  return null;
}
