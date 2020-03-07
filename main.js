/**
 *
 * pimatic adapter Copyright 2017, bluefox <dogafox@gmail.com>
 *
 */

/* jshint -W097 */
/* jshint strict:false */
/* jslint node: true */
'use strict';

// you have to require the utils module and call adapter function
var utils = require('@iobroker/adapter-core'); // Get common adapter utils
var request = require('request');
var adapter = utils.Adapter('pimatic');
var io      = require('socket.io-client');
var client;
var objects = {};
var states  = [];
var connected = false;
var url;
var getUrl;
var credentials;

// is called when adapter shuts down - callback has to be called under any circumstances!
adapter.on('unload', function (callback) {
    try {
        if (adapter.setState) adapter.setState('info.connection', false, true);
        if (client) client.disconnect();
        client = null;
        adapter.log.info('cleaned everything up...');
        callback();
    } catch (e) {
        callback();
    }
});

// is called if a subscribed state changes
adapter.on('stateChange', function (id, state) {
    if (state && !state.ack) {
        if (objects[id]) {
            if (objects[id].common.write && objects[id].native.control && objects[id].native.control.action) {
                states[id] = state.val;
                if (!connected) {
                    adapter.log.warn('Cannot control: no connection to pimatic "' + adapter.config.host + '"');
                } else {
                    /*client.emit('call', {
                        id: id,
                        action: objects[id].native.control.action,
                        params: {
                            deviceId: objects[id].native.control.deviceId,
                            name: objects[id].native.name,
                            type: objects[id].common.type,
                            valueOrExpression: state.val
                        }
                    });*/
                    // convert values
                    if (objects[id].common.type === 'boolean') {
                        state.val = (state.val === true || state.val === 'true' || state.val === '1' || state.val === 1 || state.val === 'on' || state.val === 'ON');
                    } else if (objects[id].common.type === 'number') {
                        if (typeof state.val !== 'number') {
                            if (state.val === true || state.val === 'true' || state.val === 'on' || state.val === 'ON') {
                                state.val = 1;
                            } else if (state.val === false || state.val === 'false' || state.val === 'off' || state.val === 'OFF') {
                                state.val = 0;
                            } else {
                                state.val = parseFloat((state.val || '0').toString().replace(',', '.'));
                            }
                        }
                    }

                    // Update variables mod by tehmilcho
                    if (objects[id].native.control.action == 'updateVariable') {
                        
                        client.emit('call', {
                         // id: id,
                          id: objects[id].native.control.deviceId,
                          action: 'updateVariable',
                          params: {
                            name: objects[id].native.control.deviceId,
                            type: 'value',
                            valueOrExpression: state.val
                          }
                        });
                        adapter.setForeignState(id, {val: state.val, ack: true});

                    } else {

                        var link = getUrl + 'api/device/' + objects[id].native.control.deviceId + '/' + objects[id].native.control.action + '?' + objects[id].native.name + '=' + state.val;
                        adapter.log.debug('http://' + link);
                        

                        request('http://' + credentials + link, function (err, res, body) {
                            if (err || res.statusCode !== 200) {
                                adapter.log.warn('Cannot write "' + id + '": ' + (body || err || res.statusCode));
                                adapter.setForeignState(id, {val: state.val, ack: true, q: 0x40});
                            } else {
                                try {
                                    var data = JSON.parse(body);
                                    if (data.success) {
                                        adapter.log.debug(body);
                                        // the value will be updated in deviceAttributeChanged
                                    } else {
                                        adapter.log.warn('Cannot write "' + id + '": ' + body);
                                        adapter.setForeignState(id, {val: state.val, ack: true, q: 0x40});
                                    }
                                } catch (e) {
                                    adapter.log.warn('Cannot write "' + id + '": ' + body);
                                    adapter.setForeignState(id, {val: state.val, ack: true, q: 0x40});
                                }
                            }
                        });
                    }
                }
            } else {
                adapter.log.warn('State "' + id + '" is read only');
            }
        } else {
            adapter.log.warn('Unknown state "' + id + '"');
        }
    }
});

// Some message was sent to adapter instance over message box. Used by email, pushover, text2speech, ...
adapter.on('message', function (obj) {
    if (typeof obj === 'object' && obj.message) {
        if (obj.command === 'send') {
            // e.g. send email or pushover or whatever
            console.log('send command');

            // Send response in callback if required
            if (obj.callback) adapter.sendTo(obj.from, obj.command, 'Message received', obj.callback);
        }
    }
});

// is called when databases are connected and adapter received configuration.
// start here!
adapter.on('ready', function () {
    main();
});

function syncObjects(objs, callback) {
    if (!objs || !objs.length) {
        callback && callback();
        return;
    }
    var obj = objs.shift();
    adapter.getForeignObject(obj._id, function (err, oObj) {
        if (!oObj) {
            objects[obj._id] = obj;
            adapter.setForeignObject(obj._id, obj, function () {
                setTimeout(syncObjects, 0, objs, callback);
            });
        } else {
            var changed = false;
            for (var a in obj.common) {
                if (obj.common.hasOwnProperty(a) && oObj.common[a] !== obj.common[a]) {
                    changed = true;
                    oObj.common[a] = obj.common[a];
                }
            }
            if (JSON.stringify(obj.native) !== JSON.stringify(oObj.native)) {
                changed = true;
                oObj.native = obj.native;
            }
            objects[obj._id] = oObj;
            if (changed) {
                adapter.setForeignObject(oObj._id, oObj, function () {
                    setTimeout(syncObjects, 0, objs, callback);
                });
            } else {
                setTimeout(syncObjects, 0, objs, callback);
            }
        }
    });
}

function syncStates(_states, callback) {
    if (!_states || !_states.length) {
        callback && callback();
        return;
    }
    var state = _states.shift();
    adapter.getForeignState(state._id, function (err, oState) {
        if (!oState) {
            adapter.setForeignState(state._id, state.val, function () {
                setTimeout(syncStates, 0, _states, callback);
            });
        } else {
            var changed = false;
            for (var a in state.val) {
                if (state.val.hasOwnProperty(a) &&
                    (typeof state.val[a] !== 'object' && state.val[a] !== oState[a]) ||
                    (typeof state.val[a] === 'object' && JSON.stringify(state.val[a]) !== JSON.stringify(oState[a]))) {
                    changed = true;
                    oState[a] = state.val[a];
                }
            }
            if (changed) {
                adapter.setForeignState(oState._id, oState, function () {
                    setTimeout(syncStates, 0, _states, callback);
                });
            } else {
                setTimeout(syncStates, 0, _states, callback);
            }
        }
    });
}

function syncDevices(devices, callback) {
    var objs = [];
    var _states = [];
    for (var d = 0; d < devices.length; d++) {
        var localObjects = [];
        var device = devices[d];
       // adapter.log.debug('Handle Device: ' + JSON.stringify(device));
       adapter.log.debug('Handle Device: ' + device.id);
        var obj = {
            _id: adapter.namespace + '.devices.' + device.id,
            common: {
                name: device.name
            },
            type: 'channel'
        };
        objs.push(obj);
        var attributes = device.attributes;
        if ((!attributes || !attributes.length) && device.config) attributes = device.config.attributes;

        if (attributes && attributes.length) {
            for (var a = 0; a < attributes.length; a++) {
                var attr = attributes[a];
                adapter.log.debug('Handle Attribute: ' + JSON.stringify(attr));
                var id = adapter.namespace + '.devices.' + device.id + '.' + attr.name.replace(/\s/g, '_');
                obj = {
                    _id: id,
                    common: {
                        name: device.name + ' - ' + (attr.acronym || attr.name),
                        desc: attr.description,
                        type: attr.type,
                        read: true,
                        write: false,
                        unit: attr.unit === 'c' ? '°C' : (attr.unit === 'f' ? '°F' : attr.unit)
                        //role: acronym2role(attr.acronym)
                    },
                    native: {

                    },
                    type: 'state'
                };
                _states.push({
                    _id: id,
                    val: {
                        ack: true,
                        val: attr.value,
                        ts:  attr.lastUpdate
                    }
                });
                states[id] = attr.value;
                delete attr.value;
                delete attr.lastUpdate;
                delete attr.history;
                obj.native = attr;

                if (obj.common.type === 'boolean') {
                    if (device.template === 'presence') obj.common.role = 'state';//'indicator.presence';
                    if (attr.labels && attr.labels[0] !== 'true') {
                        obj.common.states = {false: attr.labels[1], true: attr.labels[0]};
                    }
                } else
                if (obj.common.type === 'number') {
                    if (obj.common.unit === '°C' || obj.common.unit === '°F') {
                        obj.common.role = 'value.temperature';
                    } else if (obj.common.unit === '%') {
                        obj.common.min = 0;
                        obj.common.max = 100;

                        // Detect if temperature exists
                        var found = false;
                        for (var k = 0; k < localObjects.length; k++) {
                            if (localObjects[k].common.unit === '°C' || localObjects[k].common.unit === '°F') {
                                found = true;
                                break;
                            }
                        }
                        if (found) {
                            obj.common.role = 'value.humidity';
                        }
                    }
                    if (attr.name === 'latitude') {
                        obj.common.role = 'value.gps.latitude';
                    } else if (attr.name === 'longitude') {
                        obj.common.role = 'value.gps.longitude';
                    } if (attr.name === 'gps') {
                        obj.common.role = 'value.gps';
                    }
                } else {
                    if (attr.name === 'battery') {
                        obj.common.role = 'indicator.battery';
                        obj.native.mapping = {'ok': false, 'low': true};
                        obj.common.type = 'boolean';
                        obj.common.states = {false: 'ok', true: 'low'};
                        attr.value = (attr.value !== 'ok');
                    }
                }

                if (attr.enum && !obj.common.states) {
                    obj.common.states = {};
                    for (var e = 0; e < attr.enum.length; e++) {
                        if (attr.enum[e] === 'manu') {
                            obj.common.states.manu = 'manual';
                        } else if (attr.enum[e] === 'auto') {
                            obj.common.states.auto = 'automatic';
                        } else{
                            obj.common.states[attr.enum[e]] = attr.enum[e];
                        }
                    }
                }
                objs.push(obj);
                localObjects.push(obj);
            }
        }

        var actions = device.actions;
        if ((!actions || !actions.length) && device.config) actions = device.config.actions;

        if (actions && actions.length) {
            for (var c = 0; c < actions.length; c++) {
                var action = actions[c];

                for (var p in action.params) {
                    if (!action.params.hasOwnProperty(p)) continue;
                    // try to find state for that
                    var _found = false;
                    for (var u = 0; u < localObjects.length; u++) {
                        if (localObjects[u].native.name === p) {
                            _found = true;
                            obj = localObjects[u];
                            obj.native.control = {
                                action: action.name,
                                deviceId: device.id
                            };
                            obj.common.write = true;
                            if (obj.common.role === 'value.temperature') obj.common.role = 'level.temperature';
                        }
                    }

                    if (!_found) {
                        obj = {
                            _id: adapter.namespace + '.devices.' + device.id + '.' + action.name.replace(/\s/g, '_') + '.' + p.replace(/\s/g, '_'),
                            common: {
                                desc: action.params[p].description || action.description,
                                name: device.name + ' - ' + action.name + '.' + p,
                                read: false,
                                write: true,
                                type: action.params[p].type
                            },
                            native: {
                                name: p,
                                control: {
                                    action: action.name,
                                    deviceId: device.id
                                }
                            },
                            type: 'state'
                        };
                        objs.push(obj);
                    }
                }
            }
        }
    }
    var ids = [];
    for (var j = 0; j < objs.length; j++) {
        ids.push(objs[j]._id);
        objects[objs[j]._id] = objs[j];
    }
    syncObjects(objs, function () {
        syncStates(_states, function () {
            callback && callback(ids);
        });
    });
}

// Update variables mod by tehmilcho

function syncVariables(variables, callback) {
    var objs = [];
    var _states = [];
    
    for (var v = 0; v < variables.length; v++) {
        var localObjects = [];
        var variable = variables[v];
        if (variable.readonly == false) {
        adapter.log.debug('Handle Variables: ' + JSON.stringify(variable));
        var obj = {
            _id: adapter.namespace + '.devices.' + variable.name,
            common: {
                name: variable.name,
                read: true,
                write: true,
                role: 'pimatic-variable'
            },
            native: {
                name: variable.name,
                control: {
                    action: 'updateVariable',
                    deviceId: variable.name
                }
            },
            type: 'state'
        };
        _states.push({
                    _id: adapter.namespace + '.devices.' + variable.name,
                    val: {
                        ack: true,
                        val: variable.value,
                    }
        });
        objs.push(obj);
        localObjects.push(obj);
       }
    }
    var ids = [];
    for (var vj = 0; vj < objs.length; vj++) {
        ids.push(objs[vj]._id);
        objects[objs[vj]._id] = objs[vj];
    }
    syncObjects(objs, function () {
        syncStates(_states, function () {
            callback && callback(ids);
        });
    });
}
function syncGroups(groups, ids, callback) {
    var enums = [];
    var obj = {
        _id: 'enum.pimatic',
        common: {
            members: [],
            name: 'Pimatic groups'
        },
        native: {},
        type: 'enum'

    };

    enums.push(obj);

    for (var g = 0; g < groups.length; g++) {
        obj = {
            _id: 'enum.pimatic.' + groups[g].id,
            type: 'enum',
            common: {
                name: groups[g].name,
                members: []
            },
            native: {}
        };
        for (var m = 0; m < groups[g].devices.length; m++) {
            var id = adapter.namespace + '.devices.' + groups[g].devices[m].replace(/\s/g, '_');
            if (ids.indexOf(id) === -1) {
                // try to find
                var found = false;
                var _id = id.toLowerCase();
                for (var i = 0; i < ids.length; i++) {
                    if (ids[i].toLowerCase() === _id) {
                        id = ids[i];
                        found = true;
                        break;
                    }
                }
                if (found) {
                    obj.common.members.push(id);
                } else {
                    adapter.log.warn('Device "' + groups[g].devices[m] + '" was found in the group "' + groups[g].name + '", but not found in devices');
                }
            } else {
                obj.common.members.push(id);
            }
        }
        enums.push(obj);
    }
    syncObjects(enums, callback);
}

function updateConnected(isConnected) {
    if (connected !== isConnected) {
        connected = isConnected;
        adapter.setState('info.connection', connected, true);
        adapter.log.info(isConnected ? 'connected' : 'disconnected');
    }
}

function connect() {
    url = url || 'http://'  + adapter.config.host + (adapter.config.port ? ':' + adapter.config.port : '') + '/?username=' + encodeURIComponent(adapter.config.username) + '&password=';
    credentials = credentials || encodeURIComponent(adapter.config.username) + ':' + encodeURIComponent(adapter.config.password);
    getUrl = getUrl || '@' + adapter.config.host + (adapter.config.port ? ':' + adapter.config.port : '') + '/';
    adapter.log.debug('Connect: ' + url + 'xxx');
    client = io.connect(url + encodeURIComponent(adapter.config.password), {
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 3000,
        timeout: 20000,
        forceNew: true
    });
    client.on('connect', function() {
        updateConnected(true);
    });

    client.on('event', function (data) {
        adapter.log.debug(data);
    });

    client.on('disconnect', function (data) {
        updateConnected(false);
    });

    client.on('devices', function (devices) {
        updateConnected(true);
        syncDevices(devices);
    });

    client.on('rules', function (rules) {
        //adapter.log.debug('Rules ' + JSON.stringify(rules));
    });

    client.on('variables', function (variables) {

        syncVariables(variables);

        var _states = [];
        for (var s = 0; s < variables.length; s++) {
            if (variables[s].value !== undefined && variables[s].value !== null) {
                var state = {
                    _id: adapter.namespace + '.devices.' + variables[s].name.replace(/\s/g, '_'),
                    val: {
                        val: variables[s].value,
                        ack: true
                    }
                };
                if (objects[state._id]) {
                    if (objects[state._id].native && objects[state._id].native.mapping) {
                        if (objects[state._id].native.mapping[variables[s].value] !== undefined) {
                            state.val.val = objects[state._id].native.mapping[variables[s].value];
                        }
                    }
                    _states.push(state);
                } else {
                    adapter.log.warn('Unknown state: ' + state._id);
                }
            }
        }
        syncStates(_states);
    });

    client.on('pages', function (pages) {
        //adapter.log.debug('pages ' + JSON.stringify(pages));
    });

    client.on('groups', function (groups) {
        updateConnected(true);
        var ids = [];
        for (var id in objects) {
            ids.push(id);
        }
        syncGroups(groups, ids);
    });

    client.on('deviceAttributeChanged', function (attrEvent) {
        if (!attrEvent.deviceId || !attrEvent.attributeName) {
            adapter.log.warn('Received invalid event: ' + JSON.stringify(attrEvent));
            return;
        }
        var name = attrEvent.deviceId.replace(/\s/g, '_') + '.' + attrEvent.attributeName.replace(/\s/g, '_');
        adapter.log.debug('update for "' + name + '": ' + JSON.stringify(attrEvent));

        //{deviceId: device.id, attributeName, time: time.getTime(), value}
        var id = adapter.namespace + '.devices.' + name;
        if (objects[id]) {
            adapter.setForeignState(id, {val: attrEvent.value, ts: attrEvent.time, ack: true});
        } else {
             adapter.log.warn('Received update for unknown state: '+ id + ' ' + JSON.stringify(attrEvent));
        }
    });

    client.on('callResult', function (msg) {
        if (objects[msg.id]) {
            adapter.setForeignState(msg.id, states[msg.id].val, true);
        }
    });
}

function main() {
    adapter.setState('info.connection', false, true);
    connect();
    // in this pimatic all states changes inside the adapters namespace are subscribed
    adapter.subscribeStates('*');
}
