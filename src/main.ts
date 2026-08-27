/**
 * pimatic adapter
 *
 * Copyright (c) 2017-2026 bluefox <dogafox@gmail.com>
 *
 * MIT License
 */
import { Adapter, type AdapterOptions } from '@iobroker/adapter-core';
import axios from 'axios';
import io from 'socket.io-client';

import { encrypt } from './lib/crypto';
import type {
    PimaticAttributeEvent,
    PimaticCallResult,
    PimaticDevice,
    PimaticGroup,
    PimaticObject,
    PimaticStateUpdate,
    PimaticValue,
    PimaticVariable,
} from './lib/types';

/** Quality flag "the device reported an error" */
const QUALITY_DEVICE_ERROR = 0x40;
/** Role every state gets unless a more specific one is detected */
const DEFAULT_ROLE = 'state';

class Pimatic extends Adapter {
    private client: SocketIOClient.Socket | null = null;
    /** every object this adapter created, by ID */
    private readonly objects: Record<string, PimaticObject> = {};
    /** last value written for a state, by ID */
    private readonly stateValues: Record<string, PimaticValue | undefined> = {};
    private isConnected = false;
    /** socket.io URL including the user name, the password is appended when connecting */
    private url = '';
    /** host part of the REST URL, prefixed with `@` because the credentials come in front of it */
    private getUrl = '';
    /** `user:password` for the REST URL */
    private credentials = '';

    public constructor(options: Partial<AdapterOptions> = {}) {
        super({ ...options, name: 'pimatic' });

        this.on('ready', () => void this.onReady());
        this.on('stateChange', (id, state) => this.onStateChange(id, state));
        this.on('unload', callback => this.onUnload(callback));
    }

    private async onReady(): Promise<void> {
        // Old installations stored the password in plain text in `native.password`.
        // Move it into the encrypted `native.enc_password` and wait for the restart.
        if (await this.migratePassword()) {
            return;
        }

        await this.setState('info.connection', false, true);
        this.connect();
        // in this pimatic all states changes inside the adapters namespace are subscribed
        await this.subscribeStatesAsync('*');
    }

    private onUnload(callback: () => void): void {
        try {
            void this.setState('info.connection', false, true);
            this.client?.disconnect();
            this.client = null;
            this.log.info('cleaned everything up...');
            callback();
        } catch {
            callback();
        }
    }

    /**
     * Moves a plain `native.password` of an old installation into the encrypted
     * `native.enc_password`.
     *
     * @returns true if something was migrated - js-controller restarts the adapter in that
     * case and the caller must not continue.
     */
    private async migratePassword(): Promise<boolean> {
        const config = this.config as ioBroker.AdapterConfig & { password?: string };
        if (config.password === undefined || config.enc_password !== undefined) {
            return false;
        }

        const systemConfig = await this.getForeignObjectAsync('system.config');
        const systemSecret = systemConfig?.native?.secret as string | undefined;
        if (!systemSecret) {
            this.log.error('No system secret found!');
            return false;
        }

        const instance = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
        if (!instance?.native) {
            this.log.error(`system.adapter.${this.namespace} not found!`);
            return false;
        }

        const plain = instance.native.password as string | undefined;
        instance.native.enc_password = plain ? encrypt(systemSecret, plain) : '';
        delete instance.native.password;

        try {
            await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, instance);
            this.log.info('Attributes are migrated and adapter will be restarted');
            return true;
        } catch (e) {
            this.log.error(`Cannot write system.adapter.${this.namespace}: ${(e as Error).message}`);
            return false;
        }
    }

    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!state || state.ack) {
            return;
        }

        const obj = this.objects[id];
        if (!obj) {
            this.log.warn(`Unknown state "${id}"`);
            return;
        }

        const common = obj.type === 'state' ? obj.common : undefined;
        const control = obj.native.control;
        if (!common?.write || !control?.action) {
            this.log.warn(`State "${id}" is read only`);
            return;
        }

        this.stateValues[id] = state.val;

        if (!this.isConnected) {
            this.log.warn(`Cannot control: no connection to pimatic "${this.config.host}"`);
            return;
        }

        // convert values
        let value = state.val;
        if (common.type === 'boolean') {
            value =
                value === true || value === 'true' || value === '1' || value === 1 || value === 'on' || value === 'ON';
        } else if (common.type === 'number' && typeof value !== 'number') {
            if (value === true || value === 'true' || value === 'on' || value === 'ON') {
                value = 1;
            } else if (value === false || value === 'false' || value === 'off' || value === 'OFF') {
                value = 0;
            } else {
                value = parseFloat((value || '0').toString().replace(',', '.'));
            }
        }

        // Update variables mod by tehmilcho
        if (control.action === 'updateVariable') {
            this.client?.emit('call', {
                id: control.deviceId,
                action: 'updateVariable',
                params: {
                    name: control.deviceId,
                    type: 'value',
                    valueOrExpression: value,
                },
            });
            void this.setForeignStateAsync(id, { val: value, ack: true });
        } else {
            void this.callDeviceAction(id, control.action, control.deviceId, obj.native.name, value);
        }
    }

    /** Writes a value by calling the pimatic REST API */
    private async callDeviceAction(
        id: string,
        action: string,
        deviceId: string,
        name: string | undefined,
        value: PimaticValue,
    ): Promise<void> {
        const link = `${this.getUrl}api/device/${deviceId}/${action}?${name}=${value}`;
        this.log.debug(`http://${link}`);

        try {
            // axios rejects on every status but 2xx, so the old "err || statusCode !== 200"
            // branch and the JSON.parse() error branch both end up in the catch below
            const response = await axios.get<{ success?: boolean }>(`http://${this.credentials}${link}`);
            if (response.data?.success) {
                this.log.debug(JSON.stringify(response.data));
                // the value will be updated in deviceAttributeChanged
            } else {
                this.log.warn(`Cannot write "${id}": ${JSON.stringify(response.data)}`);
                await this.setForeignStateAsync(id, { val: value, ack: true, q: QUALITY_DEVICE_ERROR });
            }
        } catch (e) {
            this.log.warn(`Cannot write "${id}": ${(e as Error).message}`);
            await this.setForeignStateAsync(id, { val: value, ack: true, q: QUALITY_DEVICE_ERROR });
        }
    }

    /** Creates or updates the given objects, but writes only what really changed */
    private async syncObjects(objs: PimaticObject[]): Promise<void> {
        for (const obj of objs) {
            const oObj = (await this.getForeignObjectAsync(obj._id)) as PimaticObject | null | undefined;
            if (!oObj) {
                this.objects[obj._id] = obj;
                await this.setForeignObjectAsync(obj._id, obj);
                continue;
            }

            let changed = false;
            const common = obj.common as unknown as Record<string, unknown>;
            const oCommon = oObj.common as unknown as Record<string, unknown>;
            for (const attr of Object.keys(common)) {
                if (oCommon[attr] !== common[attr]) {
                    changed = true;
                    oCommon[attr] = common[attr];
                }
            }
            if (JSON.stringify(obj.native) !== JSON.stringify(oObj.native)) {
                changed = true;
                oObj.native = obj.native;
            }
            this.objects[obj._id] = oObj;
            if (changed) {
                await this.setForeignObjectAsync(oObj._id, oObj);
            }
        }
    }

    /** Writes the given states, but only what really changed */
    private async syncStates(updates: PimaticStateUpdate[]): Promise<void> {
        for (const update of updates) {
            const oState = await this.getForeignStateAsync(update._id);
            if (!oState) {
                await this.setForeignStateAsync(update._id, update.val as ioBroker.SettableState);
                continue;
            }

            let changed = false;
            const target = oState as unknown as Record<string, unknown>;
            const source = update.val as unknown as Record<string, unknown>;
            for (const attr of Object.keys(source)) {
                const value = source[attr];
                const current = target[attr];
                if (
                    (typeof value !== 'object' && value !== current) ||
                    (typeof value === 'object' && JSON.stringify(value) !== JSON.stringify(current))
                ) {
                    changed = true;
                    target[attr] = value;
                }
            }
            if (changed) {
                await this.setForeignStateAsync(update._id, oState);
            }
        }
    }

    private async syncDevices(devices: PimaticDevice[]): Promise<string[]> {
        const objs: PimaticObject[] = [];
        const updates: PimaticStateUpdate[] = [];

        for (const device of devices) {
            /** objects of this device, needed to find the state an action parameter belongs to */
            const localObjects: PimaticObject[] = [];
            this.log.debug(`Handle Device: ${device.id}`);

            objs.push({
                _id: `${this.namespace}.devices.${device.id}`,
                common: { name: device.name },
                native: {},
                type: 'channel',
            });

            const attributes = device.attributes?.length ? device.attributes : device.config?.attributes;
            for (const attr of attributes ?? []) {
                this.log.debug(`Handle Attribute: ${JSON.stringify(attr)}`);
                const id = `${this.namespace}.devices.${device.id}.${attr.name.replace(/\s/g, '_')}`;

                const obj: PimaticObject = {
                    _id: id,
                    common: {
                        name: `${device.name} - ${attr.acronym || attr.name}`,
                        desc: attr.description,
                        type: attr.type,
                        read: true,
                        write: false,
                        role: DEFAULT_ROLE,
                        unit: attr.unit === 'c' ? '°C' : attr.unit === 'f' ? '°F' : attr.unit,
                    },
                    native: {},
                    type: 'state',
                };

                updates.push({ _id: id, val: { ack: true, val: attr.value, ts: attr.lastUpdate } });
                this.stateValues[id] = attr.value;

                // everything that is not a value is kept in `native`
                delete attr.value;
                delete attr.lastUpdate;
                delete attr.history;
                obj.native = attr;

                if (obj.common.type === 'boolean') {
                    if (device.template === 'presence') {
                        obj.common.role = 'state'; // 'indicator.presence';
                    }
                    if (attr.labels && attr.labels[0] !== 'true') {
                        obj.common.states = { false: attr.labels[1], true: attr.labels[0] };
                    }
                } else if (obj.common.type === 'number') {
                    if (obj.common.unit === '°C' || obj.common.unit === '°F') {
                        obj.common.role = 'value.temperature';
                    } else if (obj.common.unit === '%') {
                        obj.common.min = 0;
                        obj.common.max = 100;

                        // Detect if temperature exists
                        const hasTemperature = localObjects.some(
                            o => o.type === 'state' && (o.common.unit === '°C' || o.common.unit === '°F'),
                        );
                        if (hasTemperature) {
                            obj.common.role = 'value.humidity';
                        }
                    }
                    if (attr.name === 'latitude') {
                        obj.common.role = 'value.gps.latitude';
                    } else if (attr.name === 'longitude') {
                        obj.common.role = 'value.gps.longitude';
                    }
                    // deliberately not an "else if" - a `gps` attribute wins over latitude/longitude
                    if (attr.name === 'gps') {
                        obj.common.role = 'value.gps';
                    }
                } else if (attr.name === 'battery') {
                    obj.common.role = 'indicator.battery';
                    obj.native.mapping = { ok: false, low: true };
                    obj.common.type = 'boolean';
                    obj.common.states = { false: 'ok', true: 'low' };
                    // `attr.value` was deleted above, so this always yields true - see CLAUDE.md
                    attr.value = attr.value !== 'ok';
                }

                if (attr.enum && !obj.common.states) {
                    const states: Record<string, string> = {};
                    for (const value of attr.enum) {
                        if (value === 'manu') {
                            states.manu = 'manual';
                        } else if (value === 'auto') {
                            states.auto = 'automatic';
                        } else {
                            states[value] = value;
                        }
                    }
                    obj.common.states = states;
                }

                objs.push(obj);
                localObjects.push(obj);
            }

            const actions = device.actions?.length ? device.actions : device.config?.actions;
            for (const action of actions ?? []) {
                for (const [param, definition] of Object.entries(action.params ?? {})) {
                    // try to find the state this action parameter belongs to
                    const existing = localObjects.filter(o => o.native.name === param);
                    for (const obj of existing) {
                        obj.native.control = { action: action.name, deviceId: device.id };
                        if (obj.type === 'state') {
                            obj.common.write = true;
                            if (obj.common.role === 'value.temperature') {
                                obj.common.role = 'level.temperature';
                            }
                        }
                    }

                    if (!existing.length) {
                        objs.push({
                            _id: `${this.namespace}.devices.${device.id}.${action.name.replace(/\s/g, '_')}.${param.replace(/\s/g, '_')}`,
                            common: {
                                desc: definition.description || action.description,
                                name: `${device.name} - ${action.name}.${param}`,
                                read: false,
                                write: true,
                                role: DEFAULT_ROLE,
                                type: definition.type,
                            },
                            native: {
                                name: param,
                                control: {
                                    action: action.name,
                                    deviceId: device.id,
                                },
                            },
                            type: 'state',
                        });
                    }
                }
            }
        }

        const ids = objs.map(obj => obj._id);
        for (const obj of objs) {
            this.objects[obj._id] = obj;
        }

        await this.syncObjects(objs);
        await this.syncStates(updates);
        return ids;
    }

    // Update variables mod by tehmilcho
    private async syncVariables(variables: PimaticVariable[]): Promise<string[]> {
        const objs: PimaticObject[] = [];
        const updates: PimaticStateUpdate[] = [];

        for (const variable of variables) {
            this.log.debug(`Handle Variables: ${JSON.stringify(variable)}`);

            // the ID must be built in the same way as in the "deviceAttributeChanged" handler
            const id = `${this.namespace}.devices.${variable.name.replace(/\s/g, '_')}`;

            const obj: PimaticObject = {
                _id: id,
                common: {
                    name: variable.name,
                    read: true,
                    // read-only variables (expressions) cannot be written back to pimatic
                    write: !variable.readonly,
                    // pimatic variables are not typed: the value can be a number, a string or a boolean
                    type: 'mixed',
                    role: 'pimatic-variable',
                },
                native: {
                    // pimatic requires the original name and not the sanitized ID
                    name: variable.name,
                },
                type: 'state',
            };

            if (!variable.readonly) {
                obj.native.control = { action: 'updateVariable', deviceId: variable.name };
            }

            if (variable.value !== undefined && variable.value !== null) {
                let value: PimaticValue = variable.value;
                const mapping = this.objects[id]?.native.mapping;
                if (mapping && mapping[String(value)] !== undefined) {
                    value = mapping[String(value)];
                }
                updates.push({ _id: id, val: { ack: true, val: value } });
            }

            objs.push(obj);
        }

        const ids = objs.map(obj => obj._id);
        for (const obj of objs) {
            this.objects[obj._id] = obj;
        }

        await this.syncObjects(objs);
        await this.syncStates(updates);
        return ids;
    }

    private async syncGroups(groups: PimaticGroup[], ids: string[]): Promise<void> {
        const enums: PimaticObject[] = [
            {
                _id: 'enum.pimatic',
                common: {
                    members: [],
                    name: 'Pimatic groups',
                },
                native: {},
                type: 'enum',
            },
        ];

        for (const group of groups) {
            const members: string[] = [];

            for (const device of group.devices) {
                const id = `${this.namespace}.devices.${device.replace(/\s/g, '_')}`;
                if (ids.includes(id)) {
                    members.push(id);
                    continue;
                }

                // try to find it ignoring the case
                const lower = id.toLowerCase();
                const found = ids.find(candidate => candidate.toLowerCase() === lower);
                if (found) {
                    members.push(found);
                } else {
                    this.log.warn(
                        `Device "${device}" was found in the group "${group.name}", but not found in devices`,
                    );
                }
            }

            enums.push({
                _id: `enum.pimatic.${group.id}`,
                type: 'enum',
                common: {
                    name: group.name,
                    members,
                },
                native: {},
            });
        }

        await this.syncObjects(enums);
    }

    private updateConnected(isConnected: boolean): void {
        if (this.isConnected !== isConnected) {
            this.isConnected = isConnected;
            void this.setState('info.connection', this.isConnected, true);
            this.log.info(isConnected ? 'connected' : 'disconnected');
        }
    }

    private connect(): void {
        const host = `${this.config.host}${this.config.port ? `:${this.config.port}` : ''}`;
        this.url ||= `http://${host}/?username=${encodeURIComponent(this.config.username)}&password=`;
        this.credentials ||= `${encodeURIComponent(this.config.username)}:${encodeURIComponent(this.config.enc_password)}`;
        this.getUrl ||= `@${host}/`;

        this.log.debug(`Connect: ${this.url}xxx`);

        this.client = io.connect(this.url + encodeURIComponent(this.config.enc_password), {
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 3000,
            timeout: 20000,
            forceNew: true,
        });

        this.client.on('connect', () => this.updateConnected(true));
        this.client.on('disconnect', () => this.updateConnected(false));

        this.client.on('event', (data: unknown) =>
            this.log.debug(typeof data === 'string' ? data : JSON.stringify(data)),
        );

        this.client.on('devices', (devices: PimaticDevice[]) => {
            this.updateConnected(true);
            void this.syncDevices(devices);
        });

        // pimatic also emits "rules" and "pages", both are ignored by this adapter
        this.client.on('variables', (variables: PimaticVariable[]) => {
            // syncVariables creates the objects AND writes the values
            void this.syncVariables(variables);
        });

        this.client.on('groups', (groups: PimaticGroup[]) => {
            this.updateConnected(true);
            void this.syncGroups(groups, Object.keys(this.objects));
        });

        this.client.on('deviceAttributeChanged', (attrEvent: PimaticAttributeEvent) => {
            if (!attrEvent.deviceId || !attrEvent.attributeName) {
                this.log.warn(`Received invalid event: ${JSON.stringify(attrEvent)}`);
                return;
            }
            const name = `${attrEvent.deviceId.replace(/\s/g, '_')}.${attrEvent.attributeName.replace(/\s/g, '_')}`;
            this.log.debug(`update for "${name}": ${JSON.stringify(attrEvent)}`);

            const id = `${this.namespace}.devices.${name}`;
            if (this.objects[id]) {
                void this.setForeignStateAsync(id, { val: attrEvent.value, ts: attrEvent.time, ack: true });
            } else {
                this.log.warn(`Received update for unknown state: ${id} ${JSON.stringify(attrEvent)}`);
            }
        });

        this.client.on('callResult', (msg: PimaticCallResult) => {
            if (this.objects[msg.id]) {
                void this.setForeignStateAsync(msg.id, this.stateValues[msg.id] ?? null, true);
            }
        });
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<AdapterOptions> | undefined): Pimatic => new Pimatic(options);
} else {
    // otherwise start the instance directly
    (() => new Pimatic())();
}
