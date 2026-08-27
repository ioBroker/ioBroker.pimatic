/**
 * Structures of the pimatic socket.io API.
 *
 * pimatic sends plain JSON without a schema, so these interfaces describe what the adapter
 * actually reads. Everything that is only forwarded into `native` is kept as an index signature.
 */

/** Value of a pimatic attribute or variable - pimatic is not typed, everything can arrive */
export type PimaticValue = string | number | boolean | null;

/** One attribute (= readable value) of a pimatic device */
export interface PimaticAttribute {
    name: string;
    /** Short name, preferred over `name` for the object name */
    acronym?: string;
    description?: string;
    /** `string`, `number` or `boolean` - taken over as `common.type` unchanged */
    type: ioBroker.CommonType;
    unit?: string;
    /** Labels for booleans: `[trueLabel, falseLabel]` */
    labels?: string[];
    enum?: string[];
    value?: PimaticValue;
    lastUpdate?: number;
    history?: unknown;
    /** the whole attribute is stored in `native`, so unknown members must survive */
    [other: string]: unknown;
}

/** One parameter of a pimatic action */
export interface PimaticActionParam {
    type: ioBroker.CommonType;
    description?: string;
}

/** One callable action of a pimatic device */
export interface PimaticAction {
    name: string;
    description?: string;
    params?: Record<string, PimaticActionParam>;
}

/** A pimatic device as delivered by the `devices` event */
export interface PimaticDevice {
    id: string;
    name: string;
    template?: string;
    attributes?: PimaticAttribute[];
    actions?: PimaticAction[];
    /** older pimatic versions deliver attributes and actions inside `config` */
    config?: {
        attributes?: PimaticAttribute[];
        actions?: PimaticAction[];
    };
}

/** A pimatic variable as delivered by the `variables` event */
export interface PimaticVariable {
    name: string;
    /** read-only variables are expressions and cannot be written back */
    readonly: boolean;
    value?: PimaticValue;
    unit?: string;
}

/** A pimatic group as delivered by the `groups` event */
export interface PimaticGroup {
    id: string;
    name: string;
    /** device IDs, they may differ in case from the IDs of the `devices` event */
    devices: string[];
}

/** Payload of the `deviceAttributeChanged` event */
export interface PimaticAttributeEvent {
    deviceId: string;
    attributeName: string;
    /** milliseconds since epoch */
    time: number;
    value: PimaticValue;
}

/** Payload of the `callResult` event */
export interface PimaticCallResult {
    id: string;
}

/** How to write a value back to pimatic - stored in `native.control` */
export interface PimaticControl {
    /** name of the pimatic action, `updateVariable` for variables */
    action: string;
    /** device ID, respectively the variable name */
    deviceId: string;
}

/** `native` of every object this adapter creates */
export interface PimaticNative {
    /** name of the attribute resp. the action parameter, needed to build the REST URL */
    name?: string;
    control?: PimaticControl;
    /** optional value translation, e.g. `{ ok: false, low: true }` for battery attributes */
    mapping?: Record<string, PimaticValue>;
    [other: string]: unknown;
}

/** An object that is written by `syncObjects()` */
export type PimaticObject = (ioBroker.StateObject | ioBroker.ChannelObject | ioBroker.EnumObject) & {
    native: PimaticNative;
};

/** The part of an ioBroker state this adapter ever sets */
export interface PimaticSettableState {
    /** can be undefined: pimatic delivers attributes without a value */
    val: PimaticValue | undefined;
    ack?: boolean;
    ts?: number;
    q?: number;
}

/** A state that is written by `syncStates()` */
export interface PimaticStateUpdate {
    _id: string;
    val: PimaticSettableState;
}
