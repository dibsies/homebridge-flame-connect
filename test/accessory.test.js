import assert from 'node:assert/strict';
import test from 'node:test';

import { FlameConnectCloudError } from '../src/flameconnect/errors.js';
import { FlameConnectAccessory } from '../src/accessory.js';
import { FlameConnectClient } from '../src/flameconnect/client.js';
import { decodeParameter } from '../src/flameconnect/protocol.js';

function fixture(config = {}, accessory) {
  const characteristic = (name, values = {}) => ({ ...values, toString: () => name });
  const Characteristic = {
    Name: characteristic('Name'), ConfiguredName: characteristic('ConfiguredName'),
    On: characteristic('On'), Brightness: characteristic('Brightness'),
    Hue: characteristic('Hue'), Saturation: characteristic('Saturation'),
    Active: characteristic('Active', { INACTIVE: 0, ACTIVE: 1 }),
    RotationSpeed: characteristic('RotationSpeed'),
    TargetHeatingCoolingState: characteristic('TargetHeatingCoolingState', { OFF: 0, HEAT: 1 }),
    CurrentHeatingCoolingState: characteristic('CurrentHeatingCoolingState', { OFF: 0, HEAT: 1 }),
    TargetTemperature: characteristic('TargetTemperature'),
    CurrentTemperature: characteristic('CurrentTemperature'),
    TemperatureDisplayUnits: characteristic('TemperatureDisplayUnits', { CELSIUS: 0, FAHRENHEIT: 1 }),
  };
  const Service = {
    Switch: {UUID:'switch'}, Lightbulb:{UUID:'light'}, Thermostat:{UUID:'thermostat'},
    Fanv2:{UUID:'fan'}, AccessoryInformation:{UUID:'info'},
  };
  accessory ||= {
    context: {}, services: [], getService() {},
    addService(type, name, subtype) {
      const values = {};
      const service = {
        UUID: type.UUID, subtype, displayName:name,
        getCharacteristic(k) { return values[k] ||= {
          value: '', props: {}, onGet(fn) {this.getter=fn; return this;},
          onSet(fn) {this.setter=fn; return this;}, setProps(props) {this.props=props; return this;},
        }; },
        setCharacteristic(k,v) {this.getCharacteristic(k).value=v; return this;},
        updateCharacteristic(k,v) {return this.setCharacteristic(k,v);},
        addOptionalCharacteristic() {},
      };
      this.services.push(service); return service;
    },
    removeService(s) {this.services=this.services.filter(x=>x!==s);},
  };
  const client = new FlameConnectClient({}, {});
  let remote = {
    flame:{flameEffect:1, flameSpeed:1, brightness:0, mediaLight:0, overheadLight:0,
      mediaColor:{red:0,green:0,blue:0,white:0}, overheadColor:{red:0,green:0,blue:0,white:0}},
    heat:{heatStatus:0,heatMode:0,setpointTemperature:22,boostDuration:1},
    log:{logEffect:0,color:{red:0,green:0,blue:0,white:0},pattern:0},
  };
  client.getFireOverview = async () => ({parameters:structuredClone(remote)});
  client.writeParameters = async (_id, entries) => {
    await Promise.resolve();
    for (const e of entries) {const p=decodeParameter(e.parameterId,e.value); remote[p.type]=p;}
  };
  const platform = {config, Service, Characteristic, client, api:{updatePlatformAccessories(){}}};
  const handler = new FlameConnectAccessory(platform, accessory, {fireId:'test', friendlyName:'Living Room Fire', withHeat:true,
    features:{advancedHeat:true,fanOnly:true,powerBoost:true,rgbLogEffect:true}});
  return {handler, accessory, client, remote:()=>remote};
}

test('configured names survive refresh and Home renames survive restart; config changes apply once', async () => {
  const f=fixture({flamesName:'Cozy Flames'});
  assert.deepEqual(f.accessory.services.map(s=>s.displayName),
    ['Fireplace','Cozy Flames','Heater','Eco Mode','Fan Only','Turbo Boost','Flame Speed','Media Bed','Media Accent','Logs']);
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

test('thermostat sets heat state and half-degree target temperature', async () => {
  const f=fixture();
  await f.handler.setHeat(true);
  await f.handler.setHeatTemperature(23.26);
  assert.equal(f.remote().heat.heatStatus,1);
  assert.equal(f.remote().heat.setpointTemperature,23.5);
  assert.equal(await f.handler.getHeatTargetState(),1);
  assert.equal(await f.handler.getHeatSetpoint(),23.5);
  assert.equal(f.handler.heatService.getCharacteristic(f.handler.platform.Characteristic.TargetTemperature).props.minStep,0.5);
});

test('heater modes use one switch each and restore safe Normal or Eco state', async () => {
  const f=fixture({turboBoostMinutes:12});
  assert.equal(f.handler.fanOnlyService.UUID,f.handler.platform.Service.Fanv2.UUID);
  await f.handler.setEcoMode(true);
  assert.equal(f.remote().heat.heatMode,2);
  assert.equal(f.remote().heat.heatStatus,0);
  await f.handler.setFanOnly(true);
  assert.equal(f.remote().heat.heatMode,3);
  assert.equal(f.remote().heat.heatStatus,1);
  await f.handler.setFanOnly(false);
  assert.equal(f.remote().heat.heatMode,2);
  assert.equal(f.remote().heat.heatStatus,0);
  await f.handler.setTurboBoost(true);
  assert.equal(f.remote().heat.heatMode,1);
  assert.equal(f.remote().heat.boostDuration,12);
  await f.handler.setTurboBoost(false);
  assert.equal(f.remote().heat.heatMode,2);
  assert.equal(f.remote().heat.heatStatus,0);
});

test('unsupported heater controls are not exposed', () => {
  const f=fixture({}, undefined);
  f.handler.fire.features={advancedHeat:false,fanOnly:false,powerBoost:false,rgbLogEffect:true};
  // Capability gating occurs at construction; construct against a separate accessory.
  const accessory={...f.accessory,context:{},services:[]};
  const handler=new FlameConnectAccessory(f.handler.platform,accessory,
    {fireId:'basic',friendlyName:'Basic',withHeat:true,features:{}});
  assert.equal(handler.ecoService,undefined);
  assert.equal(handler.fanOnlyService,undefined);
  assert.equal(handler.boostService,undefined);
});

test('logs support RGBW color and brightness without changing their on state', async () => {
  const f=fixture();
  await f.handler.setLogs(true);
  await f.handler.setLogColor('hue',120);
  await f.handler.setLogColor('saturation',100);
  await f.handler.setLogColor('brightness',50);
  assert.deepEqual(f.remote().log.color,{red:0,green:128,blue:0,white:0});
  assert.equal(f.remote().log.logEffect,1);
});

test('flame speed maps native five-step values to a labelled HomeKit percentage slider', async () => {
  const f=fixture({flameSpeedName:'Flame Motion'});
  await f.handler.setFlameSpeed(61);
  assert.equal(f.remote().flame.flameSpeed,3);
  assert.equal(await f.handler.getFlameSpeedPercent(),60);
  const speed=f.handler.speedService.getCharacteristic(f.handler.platform.Characteristic.RotationSpeed);
  assert.equal(speed.displayName,'Flame Motion');
  assert.deepEqual(speed.props,
    {minValue:20,maxValue:100,minStep:20,description:'Flame Motion'});
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

function withMockHap(handler) {
  class HapStatusError extends Error {
    constructor(status) {
      super(`HAP ${status}`);
      this.hapStatus = status;
    }
  }
  handler.platform.api.hap = {
    HapStatusError,
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402, OPERATION_TIMED_OUT: -70408 },
  };
  return HapStatusError;
}

test('cloud failures surface as HomeKit communication errors on refresh', async () => {
  const f = fixture();
  const HapStatusError = withMockHap(f.handler);
  const cloudError = new FlameConnectCloudError('timed out', { kind: 'timeout' });
  f.client.getFireOverview = async () => { throw cloudError; };
  await assert.rejects(
    f.handler.refresh(),
    (error) => error instanceof HapStatusError && error.hapStatus === -70408,
  );
});

test('setter cloud failures surface as HomeKit communication errors', async () => {
  const f = fixture();
  const HapStatusError = withMockHap(f.handler);
  const cloudError = new FlameConnectCloudError('Flame Connect API POST failed (500)');
  f.client.writeParameters = async () => { throw cloudError; };
  await assert.rejects(
    f.handler.setFlames(true),
    (error) => error instanceof HapStatusError && error.hapStatus === -70402,
  );
});

test('local validation errors are not converted to HomeKit errors', async () => {
  const f = fixture();
  withMockHap(f.handler);
  const validation = new Error('Invalid heater target temperature.');
  f.client.getFireOverview = async () => { throw validation; };
  await assert.rejects(f.handler.refresh(), (error) => error === validation);
});

test('missing HAP plumbing passes errors through unchanged', async () => {
  const f = fixture();
  const cloudError = new FlameConnectCloudError('boom');
  f.client.getFireOverview = async () => { throw cloudError; };
  await assert.rejects(f.handler.refresh(), (error) => error === cloudError);
});

test('a cloud failure briefly drains an already queued command burst without more requests', async () => {
  const f = fixture();
  withMockHap(f.handler);
  let overviewCalls = 0;
  f.client.getFireOverview = async () => {
    overviewCalls += 1;
    throw new FlameConnectCloudError('temporarily unavailable');
  };
  const results = await Promise.allSettled([
    f.handler.setFlames(true),
    f.handler.setLogs(true),
    f.handler.setHeat(true),
  ]);
  assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected', 'rejected']);
  assert.equal(overviewCalls, 1);
  assert.equal(f.handler.queueDepth, 0);
});
