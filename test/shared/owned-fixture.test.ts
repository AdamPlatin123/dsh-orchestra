import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOwnedList } from '../../shared/owned-contract.js';
import { validateTower } from '../../shared/tower-contract.js';
import { towerFromStage } from '../../src/sources/tower.ts';
import { APPROVAL_ID, approvalOf, ownedListOf, ownedOf, seatOf } from '../helpers/owned-fixture.ts';
import { busyStage } from '../helpers/tower-fixture.ts';

// test/helpers/owned-fixture.ts: its defaults pass the contracts, so the tests that build on them start from a valid
// list and a valid seat, and a field a contract gains fails here first.

test('the owned fixtures: an empty list, and one with a session waiting on its approval, pass the owned contract; a seat passes the tower\'s', () => {
  assert.deepEqual(validateOwnedList(ownedListOf()).errors, []);
  const list = ownedListOf({ owned: [ownedOf({ waiting: APPROVAL_ID })], approvals: [approvalOf()], limits: { maxOwned: 4, active: 1 } });
  assert.deepEqual(validateOwnedList(list).errors, []);
  assert.deepEqual(validateTower(towerFromStage(busyStage(), { seats: [seatOf()], nowWall: 0 })).errors, []);
});
