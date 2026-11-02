import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { describeChannel, describeChannelText, describeClock, describeJournal, describeOwnedRoutes, describePolicy, describeProtocol } from '../helpers/contract.ts';
import { CHANNEL_METHODS, STREAMS_PORT_METHODS, TOAST_PORT_METHODS } from '../../src/notify/channel.ts';
import { R } from '../helpers/records.ts';
import { mustOpen, storeFixture } from '../helpers/store.ts';

// The contract freeze (plan step 3: frozen at the end of the step; later steps code against it). The
// goldens below pin the exported names and values of shared/protocol.js, the notify channel's
// interface lists, the Clock port (exactly nowMono, nowWall, schedule, cancel; timerId
// `${class}:${entityId}:${seq}`), and the journal's line keys, record kinds, the field tree of every
// body schema and a digest of migration 0001. A change to any of them turns this test red: update the
// golden in the same commit, on purpose, and tell the lines that code against it (lane C for the Clock).
// Step 4 adds the frame and payload shapes and the strings keys, and will widen PROTOCOL then.
//
// alpha 0.2's protocol commit (slice design §2.7, §7 step 4) widens it on purpose: nine owned-session
// human verbs with their routes, nineteen error codes, and with the verbs the `human` and
// `human.result` bodies' verb enum (it only grows, so an older journal still replays). OWNED_ROUTES
// below pins the owned-session routes themselves, frozen before any handler acts on them. Step 5 (the
// check chain) adds one code on purpose: body-too-big 413, an owned-session body over 64 KiB.
// The orchestra app's owned-session handlers change it on purpose once more: owned-new moves to
// POST /api/owned/new and names its harness (codex or claude) and may name a model of the owned list;
// three codes are added (owned-ended 409, queue-full 409, spawn-failed 503).

const PROTOCOL = {
  "ACK_PHASES": ["dispatched","shown","error"],
  "ACTION_OUTCOMES": ["applied","noop:already-ended","unknown"],
  "BRAKE_STATUSES": ["ok","partial","refused","unknown"],
  "BYE_REASONS": ["shutdown","superseded","replaced","backpressure"],
  "CAUSE_KINDS": ["source","human","clock"],
  "CONFIDENCES": ["high","low"],
  "CREATE_TIME_RE": "/^[1-9][0-9]{0,19}$/",
  "CWD_TAIL_MAX": 32,
  "CWD_TAIL_RE": "/^[^\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}\\\\/]{1,32}$/u",
  "END_CLASSES": ["acted","auto-cleared","expired"],
  "ERROR_CODES": ["in-flight","actionId-reused","actionId-missing","verb-not-allowed","ui-only","item-unknown","text-too-long","brake-unavailable","not-test-root","procguard-timeout","plan-expired","not-unlocked","owned-disabled","owned-limit","slash-command","digest-mismatch","approval-gone","stale-view","still-running","source-live","cwd-gone","cwd-forbidden","unfinished-frame","source-changed","newer-format","reparse-point","import-too-big","gateway-real-data","rename-busy","host-tampered","body-too-big","owned-ended","queue-full","spawn-failed"],
  "ERROR_STATUS": {"in-flight":409,"actionId-reused":422,"actionId-missing":400,"verb-not-allowed":422,"ui-only":503,"item-unknown":404,"text-too-long":422,"brake-unavailable":503,"not-test-root":422,"procguard-timeout":503,"plan-expired":409,"not-unlocked":403,"owned-disabled":409,"owned-limit":409,"slash-command":422,"digest-mismatch":409,"approval-gone":409,"stale-view":409,"still-running":409,"source-live":409,"cwd-gone":409,"cwd-forbidden":409,"unfinished-frame":409,"source-changed":409,"newer-format":409,"reparse-point":409,"import-too-big":413,"gateway-real-data":409,"rename-busy":503,"host-tampered":503,"body-too-big":413,"owned-ended":409,"queue-full":409,"spawn-failed":503},
  "FRAME_KINDS": ["snapshot","status","tick","notify","bye"],
  "GROUPS": ["fermatas","wrong-notes","ready-for-review","reminders"],
  "HUMAN_VERBS": ["seen","snooze","acted","remind","brake","roots-add","roots-confirm","protect-add","protect-remove","dsh-connect","self-rating","owned-new","owned-message","owned-interrupt","owned-end","owned-retry","approval-allow","approval-deny","import-claude","import-dsh"],
  "HUMAN_VERB_ROUTES": {"seen":"/api/items/:id/seen","snooze":"/api/items/:id/snooze","acted":"/api/items/:id/acted","remind":"/api/reminders","brake":"/api/brake/execute","roots-add":"/api/roots/add","roots-confirm":"/api/roots/confirm","protect-add":"/api/protect/add","protect-remove":"/api/protect/remove","dsh-connect":"/api/dsh-connect","self-rating":"/api/self-rating","owned-new":"/api/owned/new","owned-message":"/api/owned/:id/message","owned-interrupt":"/api/owned/:id/interrupt","owned-end":"/api/owned/:id/end","owned-retry":"/api/owned/:id/retry","approval-allow":"/api/approvals/:id/allow","approval-deny":"/api/approvals/:id/deny","import-claude":"/api/import/claude","import-dsh":"/api/import/dsh"},
  "ID_RE": "/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/",
  "IMAGE_NAME_RE": "/^[A-Za-z0-9_.+-]{1,64}$/",
  "ITEM_KINDS": ["approval","question","failure","runaway","policy","ready-for-review","flood","reminder","unknown-outcome"],
  "ITEM_STATES": ["open","seen","snoozed","acted","auto-cleared","expired"],
  "ITEM_VERBS": ["open","peek","seen","snooze","remind","acted","brake"],
  "MODES": ["working","ui-only"],
  "MODE_REASONS": ["integrity-low","integrity-unknown","data-dir","journal-chain"],
  "NOOP_REASONS": ["already-ended"],
  "NOTIFY_STATES": ["none","pending","handed"],
  "OPEN_KINDS": ["resume","native","dsh-link","none"],
  "PERF_METRICS": ["frame-to-paint-ms","key-event-ms","long-frames","notify-handle-ms","no-result-yet","brake-unknown"],
  "PERMISSIONS": ["granted","denied","default"],
  "PROFILES": ["real","test"],
  "PROTOCOL_V": 1,
  "RESERVED_ERROR_CODES": ["ui-only"],
  "SEVERITIES": ["P0","P1","P2","P3"],
  "SNOOZE_PRESETS": ["15m","1h","tonight","tomorrow","custom"],
  "TEXT_STATES": ["present","expired","purged","lost"],
  "TITLE_ARG_NAMES": ["project","tool","version"],
  "TITLE_KEYS": ["item.approval","item.approval.guess","item.question","item.question.guess","item.failure","item.runaway","item.policy","item.flood","item.ready-for-review","item.reminder","item.unknown-outcome"],
  "TOOL_NAME_RE": "/^[A-Za-z0-9_.:-]{1,64}$/",
  "UUID_RE": "/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/",
  "VERSION_RE": "/^\\d{1,5}(?:\\.\\d{1,5}){1,3}(?:[-+][0-9A-Za-z.-]{1,32})?$/",
  "VISIBILITIES": ["visible","hidden"],
  "WHY_REASONS": ["open","reload","gap","stale","probe","backpressure"],
  // Added by the step 3 fixes: the project-name grammar (C10), and the frame and payload shapes moved here from routes.ts (C9; their trees are frozen with step 4).
  "DSH_ORIGIN_RE": "/^http:\\/\\/(?:127\\.0\\.0\\.1|\\[::1\\]|localhost):[1-9][0-9]{0,4}$/",
  "ENDED_FIELDS": "step-4",
  "FRAMES": "step-4",
  "HARNESSES": ["claude","dsh","codex"],
  "ITEM_FIELDS": "step-4",
  "PART_SHORT_RE": "/^[A-Za-z0-9_-]{1,12}$/",
  "PROJECT_NAME_MAX": 64,
  "PROJECT_NAME_RE": "/^[^\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}]{1,64}$/u",
  "S": "step-4",
  "SHAPES": "step-4",
  "compareRows": "function/2",
  "cwdTailArg": "function/1",
  "isActionOutcome": "function/1",
  "titleError": "function/1",
  "toolNameArg": "function/1",
  "versionArg": "function/1",
};

const OWNED_ROUTES = {
  "constants": {
    "CONTROL_HEADER": "x-orchestra-csrf",
    "OWNED_BODY_MAX_BYTES": 65536,
    "OWNED_TEXT_MAX_BYTES": 2048,
    "STAGE_ID_RE": "/^[0-9a-f]{20}$/",
    "SEQ_RE": "/^(?:0|[1-9][0-9]{0,15})$/",
    "IMPORT_CAN": ["resume","fork","dsh-snapshot","none"],
    "IMPORT_MODES": ["resume","fork"],
  },
  "routes": {
    "POST /api/owned/unlock-code": {"auth":"cookie","human":null,"target":null,"checks":["auth","execute"],"own":[],"failures":[],"status":204,"contract":null,"query":null,"body":null,"reply":null},
    "POST /api/owned/unlock": {"auth":"cookie","human":null,"target":null,"checks":["auth","shape","execute"],"own":[],"failures":["not-unlocked"],"status":null,"contract":null,"query":null,"body":{"fields":{"code":"re:unlockCode:/^[0-9]{8}$/"},"optional":[]},"reply":{"fields":{"csrf":"re:csrf:/^[A-Za-z0-9_-]{43}$/"},"optional":[]}},
    "GET /api/owned": {"auth":"unlocked","human":null,"target":null,"checks":["auth","shape","execute"],"own":[],"failures":[],"status":null,"contract":"OwnedList","query":null,"body":null,"reply":null},
    "GET /api/owned/:id/feed": {"auth":"unlocked","human":null,"target":"owned","checks":["auth","shape","item","execute"],"own":[],"failures":[],"status":null,"contract":"OwnedFeed","query":{"fields":{"after":"re:seq:/^(?:0|[1-9][0-9]{0,15})$/"},"optional":["after"]},"body":null,"reply":null},
    "GET /api/import/:id/check": {"auth":"unlocked","human":null,"target":"stage","checks":["auth","shape","item","execute"],"own":[],"failures":[],"status":null,"contract":null,"query":null,"body":null,"reply":{"fields":{"can":"enum:resume|fork|dsh-snapshot|none","why":{"nullable":"enum:owned-disabled|gateway-real-data|owned-limit|source-live|unfinished-frame|source-changed|cwd-gone|cwd-forbidden|import-too-big|newer-format"},"cwd":"text[260]:cwd","files":"int[0,max]"},"optional":["cwd","files"]}},
    "POST /api/owned/new": {"auth":"unlocked","human":"owned-new","target":null,"checks":["auth","ui-only","actionId","dedup","own","execute"],"own":["owned-disabled","owned-limit","text-too-long","slash-command"],"failures":["host-tampered","spawn-failed"],"status":null,"contract":null,"query":null,"body":{"fields":{"actionId":"re:uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/","text":"text[65536]:message","harness":"enum:codex|claude","model":"re:model:/^(?:zcode|opencode-go|codex)\\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/"},"optional":["model"]},"reply":{"fields":{"actionId":"re:uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/","accepted":"const:true","jseq":"int[0,max]","replayed":"const:true","ownedId":"re:id:/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/"},"optional":["replayed"]}},
    "POST /api/owned/:id/message": {"auth":"unlocked","human":"owned-message","target":"owned","checks":["auth","ui-only","actionId","dedup","item","own","execute"],"own":["text-too-long","slash-command","owned-ended","queue-full"],"failures":[],"status":null,"contract":null,"query":null,"body":{"fields":{"actionId":"re:uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/","text":"text[65536]:message"},"optional":[]},"reply":{"fields":{"actionId":"re:uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/","accepted":"const:true","jseq":"int[0,max]","replayed":"const:true","uuid":"re:uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/","queued":"int[0,max]","via":"enum:turn/start|turn/steer|queued"},"optional":["replayed"]}},
    "POST /api/owned/:id/interrupt": {"auth":"unlocked","human":"owned-interrupt","target":"owned","checks":["auth","ui-only","actionId","dedup","item","own","execute"],"own":[],"failures":[],"status":null,"contract":null,"query":null,"body":{"fields":{"actionId":"re:uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/"},"optional":[]},"reply":{"fields":{"actionId":"re:uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/","accepted":"const:true","jseq":"int[0,max]","replayed":"const:true","withdrawn":"int[0,max]","denied":"int[0,max]"},"optional":["replayed"]}},
    "POST /api/owned/:id/end": {"auth":"unlocked","human":"owned-end","target":"owned","checks":["auth","ui-only","actionId","dedup","item","own","execute"],"own":[],"failures":[],"status":null,"contract":null,"query":null,"body":{"fields":{"actionId":"re:uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/"},"optional":[]},"reply":{"fields":{"actionId":"re:uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/","accepted":"const:true","jseq":"int[0,max]","replayed":"const:true"},"optional":["replayed"]}},
    "POST /api/owned/:id/retry": {"auth":"unlocked","human":"owned-retry","target":"owned","checks":["auth","ui-only","actionId","dedup","item","own","execute"],"own":["owned-disabled","owned-limit","still-running","cwd-gone","cwd-forbidden"],"failures":["host-tampered"],"status":null,"contract":null,"query":null,"body":{"fields":{"actionId":"re:uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/","confirmGone":"const:true"},"optional":["confirmGone"]},"reply":{"fields":{"actionId":"re:uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/","accepted":"const:true","jseq":"int[0,max]","replayed":"const:true"},"optional":["replayed"]}},
    "POST /api/approvals/:id/allow": {"auth":"unlocked","human":"approval-allow","target":"approval","checks":["auth","ui-only","actionId","dedup","own","execute"],"own":["approval-gone","digest-mismatch","stale-view"],"failures":[],"status":null,"contract":null,"query":null,"body":{"fields":{"actionId":"re:uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/","digest":"re:digest:/^[0-9a-f]{64}$/","rev":"int[0,max]"},"optional":[]},"reply":{"fields":{"actionId":"re:uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/","accepted":"const:true","jseq":"int[0,max]","replayed":"const:true"},"optional":["replayed"]}},
    "POST /api/approvals/:id/deny": {"auth":"unlocked","human":"approval-deny","target":"approval","checks":["auth","ui-only","actionId","dedup","own","execute"],"own":["approval-gone"],"failures":[],"status":null,"contract":null,"query":null,"body":{"fields":{"actionId":"re:uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/"},"optional":[]},"reply":{"fields":{"actionId":"re:uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/","accepted":"const:true","jseq":"int[0,max]","replayed":"const:true"},"optional":["replayed"]}},
    "POST /api/import/claude": {"auth":"unlocked","human":"import-claude","target":"stage","checks":["auth","ui-only","actionId","dedup","item","own","execute"],"own":["owned-disabled","gateway-real-data","owned-limit","source-live","unfinished-frame","source-changed","cwd-gone","cwd-forbidden","import-too-big"],"failures":["reparse-point","source-changed","rename-busy","host-tampered"],"status":null,"contract":null,"query":null,"body":{"fields":{"actionId":"re:uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/","stageId":"re:stageId:/^[0-9a-f]{20}$/","mode":"enum:resume|fork","cwdShown":"text[260]:cwd"},"optional":[]},"reply":{"fields":{"actionId":"re:uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/","accepted":"const:true","jseq":"int[0,max]","replayed":"const:true","importId":"re:id:/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/","ownedId":"re:id:/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/"},"optional":["replayed"]}},
    "POST /api/import/dsh": {"auth":"unlocked","human":"import-dsh","target":"stage","checks":["auth","ui-only","actionId","dedup","item","own","execute"],"own":["owned-disabled","gateway-real-data","newer-format","unfinished-frame","import-too-big"],"failures":["reparse-point","source-changed","rename-busy"],"status":null,"contract":null,"query":null,"body":{"fields":{"actionId":"re:uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/","stageId":"re:stageId:/^[0-9a-f]{20}$/"},"optional":[]},"reply":{"fields":{"actionId":"re:uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/","accepted":"const:true","jseq":"int[0,max]","replayed":"const:true","importId":"re:id:/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/"},"optional":["replayed"]}},
  },
};

const CHANNEL = {
  "ACK_FIELDS": ["itemId","attempt","tabId","phase"],
  "ACK_REPLIES": ["recorded","dup","stale"],
  "CHANNEL_METHODS": ["notify","ack","clientState","streamOpened","streamClosed","onlineClients"],
  "CLIENT_STATE_FIELDS": ["tabId","visibility","frozen","permission"],
  "NOTIFY_FRAME_FIELDS": ["itemId","attempt","sev","title","project"],
  "NOTIFY_ITEM_FIELDS": ["itemId","sev","title","project","body"],
  "STREAMS_PORT_METHODS": ["liveStreams","sendNotify"],
  "STREAM_INFO_FIELDS": ["tabId","openedMono","visible","frozen","dirty"],
  "TOAST_PORT_METHODS": ["show","onShown"],
  "TOAST_SHOW_FIELDS": ["itemId","attempt","title","body"],
  "missingMethod": "function/2",
};

const CLOCK = {
  "methods": ["cancel","nowMono","nowWall","schedule"],
  "prototype": null,
  "frozen": true,
  "hub": {"real":["port"],"realPort":"function/1","virtualPort":"function/1"},
  "firedKeys": ["timerId","class","clock","due","durationMs","firedMono","firedWall"],
  "classes": ["silence","reminder","snooze","unregistered","deadline","poll"],
  "ranks": {"silence":2,"reminder":3,"snooze":3,"unregistered":5,"deadline":6,"poll":7},
  "recorded": ["silence","reminder","snooze"],
  "timerId": "reminder:rem-1:0",
  "recordFields": ["timerId","clock","durationMs","firedMono","firedWall"],
};

const JOURNAL_BODIES = {
  "brake.plan": {"planId":"id","harness":{"pid":"int[1,4294967295]","createTime":"createTime"},"roots":{"array":{"pid":"int[1,4294967295]","createTime":"createTime"},"min":1,"max":64},"nodes":{"array":{"pid":"int[1,4294967295]","createTime":"createTime"},"min":1,"max":4096},"protected":{"array":{"pid":"int[1,4294967295]","createTime":"createTime"},"min":0,"max":512},"createdMono":"int[0,max]","createdWall":"int[0,max]","ttlMs":"const:60000","expiresAt":"int[0,max]"},
  "clock": {"timerId":"timerId","clock":"enum:mono|wall","durationMs":"int[0,max]","firedMono":"int[0,max]","firedWall":"int[0,max]"},
  "command": {"commandId":"id","actionId":"uuid","verb":"enum:kill-tree","harness":{"pid":"int[1,4294967295]","createTime":"createTime"},"status":"enum:ok|partial|refused|unknown","subtrees":{"array":{"root":{"pid":"int[1,4294967295]","createTime":"createTime"},"requestId":"id","killed":"int[0,max]","residual":"int[0,max]","status":"enum:ok|partial|refused|unknown"},"min":1,"max":64}},
  "commit": {"count":"int[1,4096]","bootId":"uuid","obsMono":"int[0,max]","obsWall":"int[0,max]"},
  "event": {"partRef":"id","srcSeq":"int[0,max]","srcTime":{"nullable":"int[0,max]"},"srcTimePrecision":"enum:ms|s|none","evKind":"enum:edge|status|tool|message|waiting|approval|error","digest":"digest","snippetRef":{"nullable":"id"},"tool":{"nullable":"src:tool"},"errorCode":{"nullable":"src:errorCode"}},
  "human": {"actionId":"uuid","verb":"enum:seen|snooze|acted|remind|brake|roots-add|roots-confirm|protect-add|protect-remove|dsh-connect|self-rating|owned-new|owned-message|owned-interrupt|owned-end|owned-retry|approval-allow|approval-deny|import-claude|import-dsh","targetId":{"nullable":"target"},"requestDigest":"digest"},
  "human.result": {"actionId":"uuid","verb":"enum:seen|snooze|acted|remind|brake|roots-add|roots-confirm|protect-add|protect-remove|dsh-connect|self-rating|owned-new|owned-message|owned-interrupt|owned-end|owned-retry|approval-allow|approval-deny|import-claude|import-dsh","targetId":{"nullable":"target"},"outcome":"outcome","commandId":{"nullable":"id"},"subtrees":{"nullable":{"array":{"root":{"pid":"int[1,4294967295]","createTime":"createTime"},"requestId":"id","killed":"int[0,max]","residual":"int[0,max]","status":"enum:ok|partial|refused|unknown"},"min":1,"max":64}}},
  "item": {"itemId":"id","itemKind":"enum:approval|question|failure|runaway|policy|ready-for-review|flood|reminder|unknown-outcome","sev":"enum:P0|P1|P2|P3","group":"enum:fermatas|wrong-notes|ready-for-review|reminders","conf":"enum:high|low","projectId":{"nullable":"id"},"partRef":{"nullable":"id"},"dedupKey":"digest","reminderId":{"nullable":"id"}},
  "judgment": {"name":"enum:redact","inputDigest":"digest","ver":"int[0,max]","value":{"ver":"int[0,max]","dropped":{"nullable":"enum:env-dump"},"known":"int[0,max]","format":{"record":["pem","sk-ant","sk","github","aws","jwt","authorization","bearer","url-credentials","secret-param"],"value":"int[0,max]"},"entropy":"int[0,max]"}},
  "notified": {"itemId":"id","attempt":"int[1,max]","via":"enum:browser|toast","atMono":"int[0,max]","atWall":"int[0,max]"},
  "part": {"partRef":"id","harness":"enum:claude|dsh|codex","projectId":{"nullable":"id"},"cwd":{"nullable":"src:cwd"},"version":{"nullable":"src:version"}},
  "part.cursor": {"partRef":"id","cursor":"int[0,max]","srcSeq":"int[0,max]"},
  "project": {"projectId":"id","cwd":"src:cwd","hue":"int[0,11]"},
  "protect": {"op":"enum:add|remove","pid":"int[1,4294967295]","createTime":"createTime","reason":"enum:tuning|config"},
  "recovered": {"bytesCut":"int[1,max]"},
  "reminder": {"reminderId":"id","dueWall":"int[0,max]","snippetRef":{"nullable":"id"},"projectId":{"nullable":"id"}},
  "snooze": {"itemId":"id","untilWall":"int[0,max]"},
  "transition": {"entity":"enum:inbox_item|reminder","id":"id","from":"enum:none|open|seen|snoozed|acted|auto-cleared|expired|none|pending|fired|cancelled","to":"enum:none|open|seen|snoozed|acted|auto-cleared|expired|none|pending|fired|cancelled","cause":{"tag":"kind","cases":{"source":{"partRef":"id","srcSeq":"int[0,max]"},"human":{"actionId":"uuid"},"clock":{"timerId":"timerId"}}}},
};

const JOURNAL = {
  "lineKeys": ["body","bootId","digest","hash","jseq","kind","obsMono","obsWall","prevHash"],
  "kinds": ["brake.plan","clock","command","commit","event","human","human.result","item","judgment","notified","part","part.cursor","project","protect","recovered","reminder","snooze","transition"],
  "journalKinds": ["commit","recovered"],
  "migrations": [{"name":"0001-m0","setVersion":"PRAGMA user_version = 1","sha256":"0f6114b92429bad59918a674a3280f7ab6082a6aa1195ac518606ef09f3ae06d"}],
};


test('shared/protocol.js: exactly these exports, with these values (step 3 freezes the enums, regexes and functions\' names)', () => {
  assert.deepEqual(describeProtocol(), PROTOCOL);
});

test('the owned-session routes (alpha 0.2): auth, verb, target, checks, codes and the trees of query, body and reply, and the constants handlers code against', () => {
  assert.deepEqual(describeOwnedRoutes(), OWNED_ROUTES);
});

test('notify/channel.ts: the interface lists of the channel, StreamsPort and ToastPort', () => {
  assert.deepEqual(describeChannel(), CHANNEL);
});

test('the Clock port: exactly four methods on a frozen object without a prototype; the timer classes, their ranks, the timerId form and the clock record', () => {
  assert.deepEqual(describeClock(), CLOCK);
});

// The channel's declarations as text: type stripping erases the interfaces and the `satisfies` that ties
// the lists to them, so the freeze reads the source (plan line 532 freezes the whole interface).
const CHANNEL_TEXT_SHA256 = 'cab0deb29af76ca908131042798856d3bf3761d535d0b33740fd52ab962cb311';

test('notify/channel.ts: the declarations themselves are pinned, and each interface\'s methods are its list', () => {
  const c = describeChannelText();
  assert.deepEqual(c.interfaces, { NotifyChannel: [...CHANNEL_METHODS], StreamsPort: [...STREAMS_PORT_METHODS], ToastPort: [...TOAST_PORT_METHODS] });
  assert.equal(c.sha256, CHANNEL_TEXT_SHA256);
});

// The tables a stored body is held to at replay (records.ts: frozen contracts that may only grow, or an
// older journal stops replaying): the entities and states, the item and reminder edges with their causes
// (the item edges are this plan's reading of r4 §6.5, inbox.ts), and the item kind table.
const POLICY = {
  "entities": ["inbox_item","reminder"],
  "states": {
    "inbox_item": ["none","open","seen","snoozed","acted","auto-cleared","expired"],
    "reminder": ["none","pending","fired","cancelled"],
  },
  "itemEdges": {
    "none>open": {"source":true,"human":[],"clock":["silence","reminder"]},
    "open>seen": {"source":false,"human":["seen"],"clock":[]},
    "open>snoozed": {"source":false,"human":["snooze"],"clock":[]},
    "seen>snoozed": {"source":false,"human":["snooze"],"clock":[]},
    "snoozed>open": {"source":false,"human":[],"clock":["snooze"]},
    "open>acted": {"source":false,"human":["acted"],"clock":[]},
    "open>auto-cleared": {"source":true,"human":[],"clock":[]},
    "open>expired": {"source":false,"human":[],"clock":[]},
    "seen>acted": {"source":false,"human":["acted"],"clock":[]},
    "seen>auto-cleared": {"source":true,"human":[],"clock":[]},
    "seen>expired": {"source":false,"human":[],"clock":[]},
    "snoozed>acted": {"source":false,"human":["acted"],"clock":[]},
    "snoozed>auto-cleared": {"source":true,"human":[],"clock":[]},
    "snoozed>expired": {"source":false,"human":[],"clock":[]},
  },
  "reminderEdges": {
    "none>pending": {"source":false,"human":["remind"],"clock":[]},
    "pending>fired": {"source":false,"human":[],"clock":["reminder"]},
    "pending>cancelled": {"source":false,"human":["remind"],"clock":[]},
  },
  "kindRules": {
    "approval": {"group":"fermatas","sevs":["P1"],"confs":["high","low"],"verbs":["open","peek","seen","snooze","remind","acted"]},
    "question": {"group":"fermatas","sevs":["P1"],"confs":["high","low"],"verbs":["open","peek","seen","snooze","remind","acted"]},
    "failure": {"group":"wrong-notes","sevs":["P2"],"confs":["high"],"verbs":["open","peek","seen","snooze","remind","acted"]},
    "runaway": {"group":"wrong-notes","sevs":["P0"],"confs":["high"],"verbs":["open","peek","seen","snooze","remind","acted","brake"]},
    "policy": {"group":"wrong-notes","sevs":["P2"],"confs":["high"],"verbs":["open","peek","seen","snooze","remind","acted"]},
    "ready-for-review": {"group":"ready-for-review","sevs":["P3"],"confs":["high"],"verbs":["open","peek","seen","snooze","remind","acted"]},
    "flood": {"group":"wrong-notes","sevs":["P2"],"confs":["high"],"verbs":["open","peek","seen","snooze","remind","acted","brake"]},
    "reminder": {"group":"reminders","sevs":["P1"],"confs":["high"],"verbs":["open","peek","seen","snooze","acted"]},
    "unknown-outcome": {"group":"fermatas","sevs":["P1"],"confs":["high"],"verbs":["open","peek","seen","snooze","remind","acted"]},
  },
};

test('the replay policy tables: entities, states, the item and reminder edges with their causes, the kind table', () => {
  assert.deepEqual(describePolicy(), POLICY);
});

test('the journal: the nine line keys as written, the record kinds, the body schema of every kind and migration 0001', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  s.commit([R.part('p1')]);
  const first = JSON.parse(fs.readFileSync(f.journal, 'utf8').split('\n')[0]!) as Record<string, unknown>;
  const j = describeJournal(Object.keys(first));
  const { bodies, ...rest } = j;
  assert.deepEqual(rest, JOURNAL);
  assert.deepEqual(Object.keys(bodies as object), Object.keys(JOURNAL_BODIES));
  for (const k of Object.keys(JOURNAL_BODIES)) assert.deepEqual((bodies as Record<string, unknown>)[k], JOURNAL_BODIES[k as keyof typeof JOURNAL_BODIES], k);
});
