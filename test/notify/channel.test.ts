import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NotifyFrame, StreamInfo, StreamsPort, ToastPort, ToastShow } from '../../src/notify/channel.ts';
import {
  ACK_FIELDS, ACK_REPLIES, CHANNEL_METHODS, CLIENT_STATE_FIELDS, NOTIFY_FRAME_FIELDS, NOTIFY_ITEM_FIELDS, STREAMS_PORT_METHODS, STREAM_INFO_FIELDS,
  TOAST_PORT_METHODS, TOAST_SHOW_FIELDS, missingMethod,
} from '../../src/notify/channel.ts';
import { ACK_PHASES, PERMISSIONS, VISIBILITIES } from '../../shared/protocol.js';
import { FRAMES, routeOf } from '../../src/server/routes.ts';

// Plan step 3: the notify channel's interface, frozen here, implemented in step 5 (a fake ToastPort)
// and step 17 (the real one). These tests check the shape only: the method and field lists, that the
// wire shapes agree with them, and that a port is checked before the channel is handed it.

test('the channel, StreamsPort and ToastPort have exactly the plan\'s methods', () => {
  assert.deepEqual([...CHANNEL_METHODS], ['notify', 'ack', 'clientState', 'streamOpened', 'streamClosed', 'onlineClients']);
  assert.deepEqual([...STREAMS_PORT_METHODS], ['liveStreams', 'sendNotify']);
  assert.deepEqual([...TOAST_PORT_METHODS], ['show', 'onShown']);
  assert.deepEqual([...ACK_FIELDS], ['itemId', 'attempt', 'tabId', 'phase']);
  assert.deepEqual([...ACK_PHASES], ['dispatched', 'shown', 'error']);
  assert.deepEqual([...ACK_REPLIES], ['recorded', 'dup', 'stale']);
  assert.deepEqual([...CLIENT_STATE_FIELDS], ['tabId', 'visibility', 'frozen', 'permission']);
  assert.deepEqual([...STREAM_INFO_FIELDS], ['tabId', 'openedMono', 'visible', 'frozen', 'dirty']);
  assert.deepEqual([...TOAST_SHOW_FIELDS], ['itemId', 'attempt', 'title', 'body']);
  for (const l of [CHANNEL_METHODS, STREAMS_PORT_METHODS, TOAST_PORT_METHODS, ACK_FIELDS, ACK_REPLIES, CLIENT_STATE_FIELDS, STREAM_INFO_FIELDS, NOTIFY_ITEM_FIELDS, NOTIFY_FRAME_FIELDS, TOAST_SHOW_FIELDS]) assert.ok(Object.isFrozen(l));
});

type ObjShape = { t: 'obj'; fields: Record<string, { t: string; of?: readonly string[] }>; optional: readonly string[] };

test('the wire agrees with the interface: notify frame, notify-ack and client-state carry exactly the channel\'s fields (client-state plus its optional perf)', () => {
  assert.deepEqual(Object.keys((FRAMES.notify as ObjShape).fields), [...NOTIFY_FRAME_FIELDS]);
  const ack = routeOf('POST', '/api/notify-ack')!;
  assert.deepEqual(Object.keys((ack.body as ObjShape).fields), [...ACK_FIELDS]);
  assert.deepEqual([...(ack.body as ObjShape).fields.phase!.of!], [...ACK_PHASES]);
  assert.deepEqual([...((ack.reply as ObjShape).fields.ack!.of!)], [...ACK_REPLIES]);
  const cs = routeOf('POST', '/api/client-state')!.body as ObjShape;
  assert.deepEqual(Object.keys(cs.fields), [...CLIENT_STATE_FIELDS, 'perf']);
  assert.deepEqual([...cs.optional], ['perf']);
  assert.deepEqual([...cs.fields.visibility!.of!], [...VISIBILITIES]);
  assert.deepEqual([...cs.fields.permission!.of!], [...PERMISSIONS]);
  assert.equal(ack.human, null, 'an ack writes no human record and carries no actionId');
  assert.equal(routeOf('POST', '/api/client-state')!.human, null);
});

/** A fake ToastPort: records what it is shown, reports shown when told. */
class FakeToast implements ToastPort {
  readonly shown: ToastShow[] = [];
  #cb: ((itemId: string, attempt: number, shownMono: number) => void) | null = null;
  show(toast: ToastShow): void {
    this.shown.push(toast);
  }
  onShown(cb: (itemId: string, attempt: number, shownMono: number) => void): void {
    this.#cb = cb;
  }
  report(itemId: string, attempt: number, mono: number): void {
    this.#cb?.(itemId, attempt, mono);
  }
}

test('a fake ToastPort and a fake StreamsPort pass the port check; a port missing a method, or one that has it only on Object.prototype, does not', () => {
  const toast = new FakeToast();
  const streams: StreamsPort = {
    liveStreams: (): readonly StreamInfo[] => [{ tabId: '0b9c3d7e-1f2a-4b3c-8d4e-5f6a7b8c9d0e', openedMono: 5, visible: true, frozen: false, dirty: false }],
    sendNotify: (_tabId: string, _frame: NotifyFrame) => {},
  };
  assert.equal(missingMethod(toast, TOAST_PORT_METHODS), null, 'methods on the class prototype count');
  assert.equal(missingMethod(streams, STREAMS_PORT_METHODS), null);
  assert.equal(missingMethod({ show() {} }, TOAST_PORT_METHODS), 'onShown');
  assert.equal(missingMethod({ show: 1, onShown() {} }, TOAST_PORT_METHODS), 'show');
  assert.equal(missingMethod({ get show() { return () => {}; }, onShown() {} }, TOAST_PORT_METHODS), 'show', 'an accessor is no method: its getter never runs');
  assert.equal(missingMethod(null, TOAST_PORT_METHODS), 'show');
  Object.defineProperty(Object.prototype, 'onShown', { value: () => {}, configurable: true, writable: true });
  try {
    assert.equal(missingMethod({ show() {} }, TOAST_PORT_METHODS), 'onShown');
  } finally {
    delete (Object.prototype as Record<string, unknown>).onShown;
  }
  // The fake does what the interface says, for the shape: show records, onShown reports back.
  const got: unknown[] = [];
  toast.onShown((itemId, attempt, mono) => got.push([itemId, attempt, mono]));
  toast.show({ itemId: 'it-1', attempt: 1, title: { key: 'item.reminder', args: {} }, body: 'call Bob back' });
  toast.report('it-1', 1, 4242);
  assert.deepEqual(got, [['it-1', 1, 4242]]);
  assert.deepEqual(Object.keys(toast.shown[0]!), [...TOAST_SHOW_FIELDS]);
});
