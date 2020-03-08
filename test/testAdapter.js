/* jshint -W097 */// jshint strict:false
/*jslint node: true */
const expect = require('chai').expect;
const setup  = require(__dirname + '/lib/setup');

let objects = null;
let states  = null;
let onStateChanged = null;
let onObjectChanged = null;
let sendToID = 1;
let pimaticPID = null;

const adapterShortName = setup.adapterName.substring(setup.adapterName.indexOf('.')+1);

function checkConnectionOfAdapter(cb, counter) {
    counter = counter || 0;
    console.log('Try check #' + counter);
    if (counter > 30) {
        if (cb) cb('Cannot check connection');
        return;
    }

    states.getState('system.adapter.' + adapterShortName + '.0.alive', function (err, state) {
        if (err) console.error(err);
        if (state && state.val) {
            if (cb) cb();
        } else {
            setTimeout(function () {
                checkConnectionOfAdapter(cb, counter + 1);
            }, 1000);
        }
    });
}

function checkConnection(cb, counter) {
    counter = counter || 0;
    console.log('Try check pimatic #' + counter);
    if (counter > 30) {
        if (cb) cb('Cannot check connection');
        return;
    }

    states.getState(adapterShortName + '.0.info.connection', function (err, state) {
        if (err) console.error(err);
        if (state && state.val) {
            if (cb) cb();
        } else {
            setTimeout(function () {
                checkConnection(cb, counter + 1);
            }, 1000);
        }
    });
}

function checkValueOfState(id, value, cb, counter) {
    counter = counter || 0;
    if (counter > 20) {
        if (cb) cb('Cannot check value Of State ' + id);
        return;
    }

    states.getState(id, function (err, state) {
        if (err) console.error(err);
        if (value === null && !state) {
            if (cb) cb();
        } else
        if (state && (value === undefined || state.val === value)) {
            if (cb) cb();
        } else {
            setTimeout(function () {
                checkValueOfState(id, value, cb, counter + 1);
            }, 500);
        }
    });
}

function sendTo(target, command, message, callback) {
    onStateChanged = function (id, state) {
        if (id === 'messagebox.system.adapter.test.0') {
            callback(state.message);
        }
    };

    states.pushMessage('system.adapter.' + target, {
        command:    command,
        message:    message,
        from:       'system.adapter.test.0',
        callback: {
            message: message,
            id:      sendToID++,
            ack:     false,
            time:    (new Date()).getTime()
        }
    });
}

describe('Test ' + adapterShortName + ' adapter', function() {
    before('Test ' + adapterShortName + ' adapter: Start js-controller', function (_done) {
        this.timeout(600000); // because of first install from npm

        setup.setupController(function () {
            const config = setup.getAdapterConfig();
            // enable adapter
            config.common.enabled  = true;
            config.common.loglevel = 'debug';

            setup.setAdapterConfig(config.common, config.native);

            setup.startController(true, function(id, obj) {}, function (id, state) {
                    onStateChanged && onStateChanged(id, state);
                },
                function (_objects, _states) {
                    // copy default config https://gist.githubusercontent.com/thost96/6d784b72c03041cda42c4b986b5ba470/raw/08aedc3bc3c25da269b38921b7725658917677d5/config.json
                    const data = require('fs').readFileSync(__dirname + '/data/config.json');
                    require('fs').writeFileSync(__dirname + '/../config.json', data);
                    // start pimatic
                    const fork = require('child_process').fork;
                    pimaticPID = fork(__dirname + '/../node_modules/pimatic/pimatic.js');

                    /* cannot start pimatic... :( No idea why
                        11:56:44.403 2020-03-08 Sunday
                        11:56:45.396 [pimatic] Starting pimatic version 0.9.54
                        11:56:45.397 [pimatic] Node.js version 10.17.0
                        11:56:45.399 [pimatic] OpenSSL version 1.1.1d
                        11:56:52.572 [pimatic] An uncaught exception occurred: Error: spawn ./node_modules/pimatic/ppm.js ENOENT
                        11:56:52.572 [pimatic]>    at notFoundError (C:\pWork\ioBroker.pimatic\node_modules\cross-spawn\lib\enoent.js:11:11)
                        11:56:52.572 [pimatic]>    at verifyENOENT (C:\pWork\ioBroker.pimatic\node_modules\cross-spawn\lib\enoent.js:46:16)
                        11:56:52.572 [pimatic]>    at ChildProcess.cp.emit (C:\pWork\ioBroker.pimatic\node_modules\cross-spawn\lib\enoent.js:33:19)
                        11:56:52.572 [pimatic]>    at Process.ChildProcess._handle.onexit (internal/child_process.js:248:12)
                        11:56:52.572 [pimatic]> This is most probably a bug in pimatic or in a module, please report it!
                        11:56:52.576 [pimatic] exiting...
                    */

                    objects = _objects;
                    states  = _states;
                    _done();
                });
        });
    });

    it('Test ' + adapterShortName + ' adapter: Check if adapter started', function (done) {
        this.timeout(60000);
        //wait till pimatic started
        checkConnectionOfAdapter(function (res) {
            if (res) console.log(res);
            expect(res).not.to.be.equal('Cannot check connection');
            /*checkConnection(function (res) {
                expect(res).to.be.not.ok;
                done();
            })*/
            done();
        });
    });

    after('Test ' + adapterShortName + ' adapter: Stop js-controller', function (done) {
        this.timeout(10000);
        pimaticPID && pimaticPID.kill();

        setup.stopController(function (normalTerminated) {
            console.log('Adapter normal terminated: ' + normalTerminated);
            done();
        });
    });
});
