import assert from 'node:assert/strict';
import test from 'node:test';
import { FlameConnectAccessory } from '../src/accessory.js';
import { FlameConnectClient } from '../src/flameconnect/client.js';
import { decodeParameter } from '../src/flameconnect/protocol.js';

function fixture(config = {}, accessory) {
  const Characteristic = Object.fromEntries(['Name', 'ConfiguredName', 'On', 'Brightness', 'Hue', 'Saturation'].map(k => [k, k]));
  const Service = { Switch: {UUID:'switch'}, Lightbulb:{UUID:'light'}, AccessoryInformation:{UUID:'info'} };
  accessory ||= {
    context: {}, services: [], getService() {},
    addService(type, name, subtype) {
      const values = {};
      const service = {
        UUID: type.UUID, subtype, displayName:name,
        getCharacteristic(k) { return values[k] ||= {value: '', onGet() {return this;}, onSet() {return this;}}; },
        setCharacteristic(k,v) {this.getCharacteristic(k).value=v; return this;},
        updateCharacteristic(k,v) {return this.setCharacteristic(k,v);},
        addOptionalCharacteristic() {},
      };
      this.services.push(service); return service;
    },
    removeService(s) {this.services=this.services.filter(x=>x!==s);},
  };
  const client = new FlameConnectClient({}, {});
  let remote = {flame:{mediaLight:0,overheadLight:0}, log:{logEffect:0}};
  client.getFireOverview = async () => ({parameters:structuredClone(remote)});
  client.writeParameters = async (_id, entries) => {
    await Promise.resolve();
    for (const e of entries) {const p=decodeParameter(e.parameterId,e.value); remote[p.type]=p;}
  };
  const platform = {config, Service, Characteristic, client, api:{updatePlatformAccessories(){}}};
  const handler = new FlameConnectAccessory(platform, accessory, {fireId:'test', friendlyName:'Living Room Fire', withHeat:true, features:{rgbLogEffect:true}});
  return {handler, accessory, client, remote:()=>remote};
}

test('configured names survive refresh and Home renames survive restart; config changes apply once', async () => {
  const f=fixture({flamesName:'Cozy Flames'});
  assert.deepEqual(f.accessory.services.map(s=>s.displayName), ['Fireplace','Cozy Flames','Heater','Media Bed','Media Accent','Logs']);
  f.handler.flameService.setCharacteristic('ConfiguredName','Evening Glow');
  await f.handler.refresh();
  f.handler.updateFire({friendlyName:'New account name'},true);
  const restarted=fixture({flamesName:'Cozy Flames'},f.accessory);
  assert.equal(restarted.handler.flameService.getCharacteristic('ConfiguredName').value,'Evening Glow');
  const changed=fixture({flamesName:'Reading Light'},f.accessory);
  assert.equal(changed.handler.flameService.getCharacteristic('ConfiguredName').value,'Reading Light');
});

test('concurrent lighting commands preserve both changes and logs write through the client', async () => {
  const f=fixture();
  await Promise.all([f.handler.setFlameFlag('mediaLight',true),f.handler.setFlameFlag('overheadLight',true),f.handler.setLogs(true)]);
  assert.equal(f.remote().flame.mediaLight,1);
  assert.equal(f.remote().flame.overheadLight,1);
  assert.equal(f.remote().log.logEffect,1);
});

test('a failed command does not block later commands or report a successful local change', async () => {
  const f=fixture();
  const write=f.client.writeParameters.bind(f.client);
  f.client.writeParameters=async()=>{throw new Error('Rejected');};
  await assert.rejects(f.handler.setLogs(true),/Rejected/);
  assert.equal(f.handler.state.log.logEffect,0);
  f.client.writeParameters=write;
  await f.handler.setLogs(true);
  assert.equal(f.remote().log.logEffect,1);
});

test('cloud result-code rejection is surfaced', async () => {
  const client=new FlameConnectClient({},{});
  client.request=async()=>({ResultCode:7});
  await assert.rejects(client.writeParameters('test',[]),/result code 7/);
});

test('separate HomeKit hue, saturation, and dimmer writes retain the selected color', async () => {
  const f=fixture();
  await Promise.all([
    f.handler.setLightColor('mediaColor','hue',240),
    f.handler.setLightColor('mediaColor','saturation',100),
    f.handler.setLightColor('mediaColor','brightness',50),
  ]);
  assert.deepEqual(f.remote().flame.mediaColor,{red:0,green:0,blue:128,white:0});
  assert.equal(f.remote().flame.mediaTheme,0);
  assert.equal(f.remote().flame.overheadLight,0);
  await f.handler.setLightColor('mediaColor','brightness',0);
  await f.handler.setLightColor('mediaColor','brightness',100);
  assert.equal(f.remote().flame.mediaColor.blue,255);
  await f.handler.setLightColor('overheadColor','brightness',100);
  assert.deepEqual(f.remote().flame.overheadColor,{red:0,green:0,blue:0,white:255});
  assert.equal(f.remote().flame.mediaColor.blue,255);
});

test('default migration preserves a Home custom name', () => {
  const f=fixture();
  f.accessory.context.controlNames['media-light']='Media Light';
  f.handler.mediaService.displayName='Media Light';
  f.handler.mediaService.setCharacteristic('Name','Media Light');
  f.handler.mediaService.setCharacteristic('ConfiguredName','My Embers');
  const migrated=fixture({},f.accessory);
  assert.equal(migrated.handler.mediaService.getCharacteristic('ConfiguredName').value,'My Embers');
});
