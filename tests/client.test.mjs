import test from 'node:test';
import assert from 'node:assert/strict';
import {Cipher, newIdentity, profile} from '../vendor/pvt-remote-client/protocol.mjs';
import {ProfileStore} from '../vendor/pvt-remote-client/storage.mjs';

const publicHost = identity => ({...identity.public, type:'pvthost', endpoints:['ws://127.0.0.1:49731'], signaling_url:''});
function storage() {
  const area = () => ({data: {}, async get(keys) { if (keys === null) return structuredClone(this.data); return Object.fromEntries(keys.map(k => [k, this.data[k]])); }, async set(values) { Object.assign(this.data, structuredClone(values)); }, async remove(keys) { for (const key of keys) delete this.data[key]; }});
  return {storage:{local:area(), sync:area()}};
}

test('signed encryption roundtrip, tampering, and concurrent replay', async () => {
  const a = new Cipher(await newIdentity('control'));
  const b = new Cipher(await newIdentity('display'));
  const e = await a.seal(b.public, {op:'offer', sdp:'private SDP'});
  assert.ok(!JSON.stringify(e).includes('private SDP'));
  const results = await Promise.allSettled([b.open(a.public,e), b.open(a.public,e)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length, 1);
  assert.deepEqual(results.find(r=>r.status==='fulfilled').value, {op:'offer', sdp:'private SDP'});
  const altered = await a.seal(b.public, {op:'hello'}); altered.ct = altered.ct.slice(0,-4)+'AAAA';
  await assert.rejects(b.open(a.public, altered));
  await assert.rejects(b.open(a.public, {...e,to:a.public.id}));
  await assert.rejects(b.open(a.public, {...e,ts:0}));
});
test('pairing validation strips secrets and rejects unsafe relay URLs', async () => {
  const host = publicHost(await newIdentity('display'));
  assert.equal(profile({...host, privateKey:'secret'}, 'pvthost').privateKey, undefined);
  assert.throws(()=>profile({...host,signaling_url:'ws://remote.example'}, 'pvthost'));
  assert.throws(()=>profile({...host,ed25519:'bad'}, 'pvthost'));
});
test('local-only by default, public-only sync, restore and clear', async () => {
  const api = storage(); const store = new ProfileStore(api, 'control');
  const initial = await store.load();
  assert.equal(initial.syncEnabled,false); assert.ok(initial.identity.ed_private);
  const host = publicHost(await newIdentity('display'));
  await store.saveHosts([host],false); assert.deepEqual(api.storage.sync.data,{});
  await store.saveHosts([host],true);
  assert.ok(!JSON.stringify(api.storage.sync.data).includes('private'));
  api.storage.local.data.hosts=[];
  assert.equal((await store.load()).hosts.length,1);
  await store.clearSync(); assert.deepEqual(api.storage.sync.data,{});
  assert.equal(api.storage.local.data.syncEnabled,false);
  assert.equal(api.storage.local.data.hosts.length,1);
});
test('sync cannot silently replace a paired identity key', async () => {
  const api=storage(); const store=new ProfileStore(api,'display'); await store.load();
  const host=publicHost(await newIdentity('display'));
  await store.saveHosts([host],true);
  const changed=publicHost(await newIdentity('display')); changed.id=host.id;
  api.storage.sync.data['pvt.host.'+host.id]=changed;
  await assert.rejects(store.load(), /key changed/);
});
test('controller and display installations cannot share a role identity', async () => {
  const api=storage(); await new ProfileStore(api,'control').load();
  await assert.rejects(new ProfileStore(api,'display').load(), /role mismatch/);
});

test('reinstallation restores opt-in hosts with a new private identity', async () => {
  const api=storage(); const store=new ProfileStore(api,'control');
  const first=await store.load(); const host=publicHost(await newIdentity('display'));
  await store.saveHosts([host],true);
  api.storage.local.data={};
  const restored=await store.load();
  assert.equal(restored.syncEnabled,true); assert.equal(restored.hosts[0].id,host.id);
  assert.notEqual(restored.identity.public.id,first.identity.public.id);
  await store.disableSync();
  const localOnly=await store.load(); assert.equal(localOnly.syncEnabled,false);
});

test('enabling sync restores backup hosts while preserving edited local names and pinned keys', async () => {
  const api = storage(); const store = new ProfileStore(api, 'control');
  const local = publicHost(await newIdentity('display'));
  const backup = publicHost(await newIdentity('display'));
  await store.saveHosts([local, backup], true);
  const edited = {...local, label: 'Edited desktop'};
  const merged = await store.mergeSyncedHosts([edited], true);
  assert.equal(merged.length, 2); assert.equal(merged[0].label, 'Edited desktop');
  api.storage.sync.data['pvt.host.' + local.id] = {...backup, id: local.id};
  await assert.rejects(store.mergeSyncedHosts([edited], true), /key changed/);
});
