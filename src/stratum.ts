import * as net from 'net';
import {EventEmitter} from 'events';

import * as util from './util.js';
import * as tls from "tls";

class SubscriptionCounter {
    private count = 0;
    private padding: string = 'deadbeefcafebabe';

    next() {
        this.count++;
        if (Number.MAX_VALUE === this.count) this.count = 0;
        return this.padding + util.packInt64LE(this.count).toString('hex');
    }
}

/**
 * Defining each client that connects to the stratum server.
 * Emits:
 *  - subscription(obj, cback(error, extraNonce1, extraNonce2Size))
 *  - submit(data(name, jobID, extraNonce2, ntime, nonce))
 **/
export class StratumClient extends EventEmitter {
    remoteAddress: string;
    extraNonce1: any;

    private options: any;
    private socket: net.Socket | tls.TLSSocket;
    private lastActivity: number;
    private shares: { valid: number; invalid: number };
    private considerBan: (shareValid) => (boolean);
    private requestedSubscriptionBeforeAuth: boolean;
    private authorized: boolean;
    private workerPass: string;
    private workerName: string;
    private pendingDifficulty: null;
    private previousDifficulty: any;
    private difficulty: any;

    constructor(options) {
        super();
        this.pendingDifficulty = null;
        //private members
        this.options = options;
        this.remoteAddress = options.socket.remoteAddress;
        this.lastActivity = Date.now();

        this.shares = {valid: 0, invalid: 0};

        const _this = this;
        this.considerBan = (!this.options.banning || !this.options.banning.enabled) ? function () {
            return false
        } : function (shareValid) {
            if (shareValid === true) _this.shares.valid++;
            else _this.shares.invalid++;
            const totalShares = _this.shares.valid + _this.shares.invalid;
            if (totalShares >= _this.options.banning.checkThreshold) {
                const percentBad = (_this.shares.invalid / totalShares) * 100;
                if (percentBad < _this.options.banning.invalidPercent) //reset shares
                    _this.shares = {valid: 0, invalid: 0};
                else {
                    _this.emit('triggerBan', _this.shares.invalid + ' out of the last ' + totalShares + ' shares were invalid');
                    _this.socket.destroy();
                    return true;
                }
            }
            return false;
        };
    }

    init() {
        this.setupSocket();
    };

    handleMessage(message) {
        switch (message.method) {
            case 'mining.subscribe':
                this.handleSubscribe(message);
                break;
            case 'mining.authorize':
                this.handleAuthorize(message, true /*reply to socket*/);
                break;
            case 'mining.submit':
                this.lastActivity = Date.now();
                this.handleSubmit(message);
                break;
            case 'mining.get_transactions':
                this.sendJson({
                    id: null,
                    result: [],
                    error: true
                });
                break;
            default:
                this.emit('unknownStratumMethod', message);
                break;
        }
    }

    handleSubscribe(message) {
        const _this = this;

        if (!this.authorized) {
            this.requestedSubscriptionBeforeAuth = true;
        }
        this.emit('subscription',
            {},
            function (error, extraNonce1, extraNonce2Size) {
                if (error) {
                    _this.sendJson({
                        id: message.id,
                        result: null,
                        error: error
                    });
                    return;
                }
                _this.extraNonce1 = extraNonce1;
                _this.sendJson({
                    id: message.id,
                    result: [
                        [
                            ["mining.set_difficulty", _this.options.subscriptionId],
                            ["mining.notify", _this.options.subscriptionId]
                        ],
                        extraNonce1,
                        extraNonce2Size
                    ],
                    error: null
                });
            }
        );
    }

    handleAuthorize(message, replyToSocket) {
        const _this = this;
        this.workerName = message.params[0];
        this.workerPass = message.params[1];
        this.options.authorizeFn(this.remoteAddress, this.options.socket.localPort, this.workerName, this.workerPass, function (result) {
            _this.authorized = (!result.error && result.authorized);

            if (replyToSocket) {
                _this.sendJson({
                    id: message.id,
                    result: _this.authorized,
                    error: result.error
                });
            }

            // If the authorizer wants us to close the socket lets do it.
            if (result.disconnect === true) {
                _this.options.socket.destroy();
            }
        });
    }

    handleSubmit(message) {
        const _this = this;
        if (!this.authorized) {
            this.sendJson({
                id: message.id,
                result: null,
                error: [24, "unauthorized worker", null]
            });
            this.considerBan(false);
            return;
        }
        if (!this.extraNonce1) {
            this.sendJson({
                id: message.id,
                result: null,
                error: [25, "not subscribed", null]
            });
            this.considerBan(false);
            return;
        }
        this.emit('submit',
            {
                name: message.params[0],
                jobId: message.params[1],
                extraNonce2: message.params[2],
                nTime: message.params[3],
                nonce: message.params[4]
            },
            function (error, result) {
                if (!_this.considerBan(result)) {
                    _this.sendJson({
                        id: message.id,
                        result: result,
                        error: error
                    });
                }
            }
        );

    }

    sendJson(...args: any[]) {
        let response = '';
        for (let i = 0; i < args.length; i++) {
            response += JSON.stringify(args[i]) + '\n';
        }
        this.options.socket.write(response);
    }

    setupSocket() {
        const _this = this;
        const socket = this.options.socket;
        let dataBuffer = '';
        socket.setEncoding('utf8');

        if (this.options.tcpProxyProtocol === true) {
            socket.once('data', function (d) {
                if (d.indexOf('PROXY') === 0) {
                    _this.remoteAddress = d.split(' ')[2];
                } else {
                    _this.emit('tcpProxyError', d);
                }
                _this.emit('checkBan');
            });
        } else {
            _this.emit('checkBan');
        }
        socket.on('data', function (d) {
            dataBuffer += d;
            if (Buffer.byteLength(dataBuffer, 'utf8') > 10240) { //10KB
                dataBuffer = '';
                _this.emit('socketFlooded');
                socket.destroy();
                return;
            }
            if (dataBuffer.indexOf('\n') !== -1) {
                const messages = dataBuffer.split('\n');
                const incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
                messages.forEach(function (message) {
                    if (message === '') return;
                    let messageJson;
                    try {
                        messageJson = JSON.parse(message);
                    } catch (e) {
                        if (_this.options.tcpProxyProtocol !== true || d.indexOf('PROXY') !== 0) {
                            _this.emit('malformedMessage', message);
                            socket.destroy();
                        }
                        return;
                    }

                    if (messageJson) {
                        _this.handleMessage(messageJson);
                    }
                });
                dataBuffer = incomplete;
            }
        });
        socket.on('close', function () {
            _this.emit('socketDisconnect');
        });
        socket.on('error', function (err) {
            if (err.code !== 'ECONNRESET')
                _this.emit('socketError', err);
        });
    }

    enqueueNextDifficulty(requestedNewDifficulty) {
        this.pendingDifficulty = requestedNewDifficulty;
        return true;
    };

    sendDifficulty(difficulty) {
        if (difficulty === this.difficulty)
            return false;

        this.previousDifficulty = this.difficulty;
        this.difficulty = difficulty;
        this.sendJson({
            id: null,
            method: "mining.set_difficulty",
            params: [difficulty]//[512],
        });
        return true;
    };

    manuallyAuthClient(username, password) {
        this.handleAuthorize({id: 1, params: [username, password]}, false /*do not reply to miner*/);
    };

    manuallySetValues(otherClient) {
        this.extraNonce1 = otherClient.extraNonce1;
        this.previousDifficulty = otherClient.previousDifficulty;
        this.difficulty = otherClient.difficulty;
    };
}


/**
 * The actual stratum server.
 * It emits the following Events:
 *   - 'client.connected'(StratumClientInstance) - when a new miner connects
 *   - 'client.disconnected'(StratumClientInstance) - when a miner disconnects. Be aware that the socket cannot be used anymore.
 *   - 'started' - when the server is up and running
 **/
export class StratumServer extends EventEmitter {
    subscriptionId: number;
    private bannedMS: number;
    private stratumClients;
    private subscriptionCounter: SubscriptionCounter;
    private rebroadcastTimeout;
    private bannedIPs;
    private options;
    private authorizeFn: Function;

    constructor(options, authorizeFn) {
        super();

        this.authorizeFn = authorizeFn;
        this.bannedMS = options.banning ? options.banning.time * 1000 : null;
        this.stratumClients = {};
        this.subscriptionCounter = new SubscriptionCounter();
        this.bannedIPs = {};

        this.init()
    }

    init() {
        const _this = this;
        //Interval to look through bannedIPs for old bans and remove them in order to prevent a memory leak
        if (this.options.banning && this.options.banning.enabled) {
            setInterval(function () {
                for (let ip in _this.bannedIPs) {
                    if (!_this.bannedIPs.hasOwnProperty(ip)) {
                        continue
                    }
                    const banTime = _this.bannedIPs[ip];
                    if (Date.now() - banTime > _this.options.banning.time)
                        delete _this.bannedIPs[ip];
                }
            }, 1000 * this.options.banning.purgeInterval);
        }


        //SetupBroadcasting();

        let serversStarted = 0;
        Object.keys(this.options.ports).forEach(function (port) {
            net.createServer({allowHalfOpen: false}, function (socket) {
                _this.handleNewClient(socket);
            }).listen(parseInt(port), function () {
                serversStarted++;
                if (serversStarted == Object.keys(_this.options.ports).length)
                    _this.emit('started');
            });
        });
    }

    checkBan(client) {
        if (this.options.banning && this.options.banning.enabled && client.remoteAddress in this.bannedIPs) {
            const bannedTime = this.bannedIPs[client.remoteAddress];
            const bannedTimeAgo = Date.now() - bannedTime;
            const timeLeft = this.bannedMS - bannedTimeAgo;
            if (timeLeft > 0){
                client.socket.destroy();
                client.emit('kickedBannedIP', timeLeft / 1000 | 0);
            }
            else {
                delete this.bannedIPs[client.remoteAddress];
                client.emit('forgaveBannedIP');
            }
        }
    }

    handleNewClient(socket: net.Socket) {
        const _this = this;

        socket.setKeepAlive(true);
        const subscriptionId = this.subscriptionCounter.next();
        const client = new StratumClient(
            {
                subscriptionId: subscriptionId,
                authorizeFn: this.authorizeFn,
                socket: socket,
                banning: this.options.banning,
                connectionTimeout: this.options.connectionTimeout,
                tcpProxyProtocol: this.options.tcpProxyProtocol
            }
        );

        this.stratumClients[subscriptionId] = client;
        this.emit('client.connected', client);
        client.on('socketDisconnect', function() {
            _this.removeStratumClientBySubId(_this.subscriptionId);
            _this.emit('client.disconnected', client);
        }).on('checkBan', function(){
            _this.checkBan(client);
        }).on('triggerBan', function(){
            _this.addBannedIP(client.remoteAddress);
        }).init();
        return subscriptionId;
    };

    broadcastMiningJobs(jobParams) {
        const _this = this;

        for (const clientId in this.stratumClients) {
            const client = this.stratumClients[clientId];
            client.sendMiningJob(jobParams);
        }
        /* Some miners will consider the pool dead if it doesn't receive a job for around a minute.
           So every time we broadcast jobs, set a timeout to rebroadcast in X seconds unless cleared. */
        clearTimeout(this.rebroadcastTimeout);
        this.rebroadcastTimeout = setTimeout(function () {
            _this.emit('broadcastTimeout');
        }, this.options.jobRebroadcastTimeout * 1000);
    };

    addBannedIP(ipAddress: string) {
        this.bannedIPs[ipAddress] = Date.now();
        /*for (var c in stratumClients){
            var client = stratumClients[c];
            if (client.remoteAddress === ipAddress){
                _this.emit('bootedBannedWorker');
            }
        }*/
    };

    getStratumClients() {
        return this.stratumClients;
    };

    removeStratumClientBySubId(subscriptionId: number) {
        delete this.stratumClients[subscriptionId];
    };

    manuallyAddStratumClient(clientObj) {
        const subId = this.handleNewClient(clientObj.socket);
        if (subId != null) { // not banned!
            this.stratumClients[subId].manuallyAuthClient(clientObj.workerName, clientObj.workerPass);
            this.stratumClients[subId].manuallySetValues(clientObj);
        }
    };

}