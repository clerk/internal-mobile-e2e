import '../testing/git-env.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { configLeaves, sameLeaf, standardFile } from '../src/core/instances/settings.ts';

describe('the standard file', () => {
  it('gives each setting the tests change a standard value, as leaves', () => {
    const pinned = configLeaves(standardFile().config);
    assert.equal(pinned['auth_multi_factor.required_for_sign_up'], false);
    assert.equal(pinned['organization_settings.force_organization_selection'], false);
    assert.deepEqual(pinned['auth_email.sign_in_strategies'], ['email_code'], 'a list is one leaf');
  });

  it('requires that a user may delete their own account', () => {
    assert.equal(standardFile().environment['user_settings.actions.delete_self'], true);
  });
});

describe('comparing config leaves', () => {
  it('compares the members of a list by what they hold, in any order', () => {
    assert.equal(sameLeaf([{ a: 1 }], [{ a: 2 }]), false, 'two lists of objects of one length are not the same list');
    assert.equal(sameLeaf([{ a: 1, b: [2, 3] }, { c: null }], [{ c: null }, { b: [2, 3], a: 1 }]), true);
    assert.equal(sameLeaf(['b', 'a'], ['a', 'b']), true);
    assert.equal(sameLeaf(['a'], ['a', 'a']), false);
  });
});
