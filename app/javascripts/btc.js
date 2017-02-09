/**
 *  DFINITY Donation Chrome Extension
 *  (C) 2016 DFINITY Stiftung (http://dfinity.network)
 *
 *  This Chrome extension provides a guided process for user to donate Bitcoin or
 *  Ether, in return for DFINITY Network Participation Token (DFN) recommendation from
 *  DFINITY Stiftung, a Swiss non-profit dedicated to DFINITY Network research,
 *  development and promotion.
 *
 *  This client:
 *    - generates new seed and derive DFN address
 *    - forwards ETH/BTC from a temporary address (which is also derived from the same
 *      seed) to the Foundation Donation Contract(FDC). The FDC is a set of smart
 *      contracts running on Ethereum, which registers the donation and
 *      corresponding DFN token recommendation amount
 *    - requires connecting to a Ethereum node (regardless of Ether or Bitcoin donation)
 *    - requires connecting to a Bitcoin node for Bitcoin donation
 *    - can withdrawal remaining Eth from the temporary withdrawal address
 *
 *  Refer to FDC code for detailed logic on donation.
 *
 */
"use strict";

// The Bitcoin donation flow is as follows:

// 1. (External) The USER sends money to the CLIENT ADDRESS, a unique Bitcoin
//    address generated by this extension.

// 2. The CLIENT ADDRESS is watched for incoming transactions, and the contained
//    outputs are forwarded to the CENTRAL ADDRESS, including an OP_RETURN output
//    with the CLIENT DFINITY DATA.

// 3. One of three things happen:
//    a. (External) the funds reach the CENTRAL ADDRESS successfully, and are
//       included in the donation campaign.

//    b. A temporary failure (eg low fee, or double-spend) triggers a retry of
//       step 2.

//    c. A permanent failure (eg campaign ended) allows for a refund, sent to an
//       external address.

var bitcore = require('bitcore-lib')
var Unit = bitcore.Unit;

var TX_FEE_MULTIPLIER = 2;

function BitcoinWorker() {
    this.isWorking = false
}

BitcoinWorker.prototype.start = function(config) {
    console.log("Worker started");
    var self = this

    // Client configuration:
    self.clientPrivateKey = bitcore.PrivateKey(config.privateKey)
    self.clientAddress = self.clientPrivateKey.toAddress();
    console.log("clientDfinity data is: " + config.clientDfinityData);
    self.clientDfinityData = bitcore.util.buffer.hexToBuffer(config.clientDfinityData);

    // Central configuration:
    self.centralAddress = bitcore.Address(config.centralAddress)

    // External block explorer configuration:
    self.pollIntervalMs = config.pollIntervalMs || 5000
    self.bitcoinProvider = config.bitcoinProvider;
    self.bitcoinProvider.__proto__.getTransactions = getTransactions;
    self.bitcoinProvider.__proto__.getStatus = getStatus;

    // self worker considers itself "connected" if the last HTTP request it made
    // was successful (starts disconnected):
    self.isConnected = false

    self.listeners = {
        onConnectionChange: config.onConnectionChange || function() {},
        onError: config.onError || function() {},
    }

    // Start watching CLIENT ADDRESS and forwarding funds:
    self.isWorking = true

    function nextWatchTick() {
        if (!self.isWorking)
            return
        self.pollBTCStatus();

        self.tryForwardBTC().then(function() {
            setTimeout(nextWatchTick, self.pollIntervalMs)
        })
    }

    nextWatchTick()
}

/**
 *  This is a custom function we are adding to the Insight class as it current
 *  lacks this feature.
 *
 * Retrieve a list of transactions associated with an address or set of addresses
 * @param {Address|string} address
 * @param {GetTxsCallback} callback
 */

var getTransactions = function(address, callback) {
    this.requestGet('/api/txs/?address=' + address.toString(),
        function(err, res, body) {
            if (err || res.statusCode !== 200) {
                return callback(err || res);
            }

            var txs;
            if (body["txs"] != undefined || body["txs"] != "") {
                txs = JSON.parse(body)["txs"];
            }
            return callback(null, txs);
        });
};

var getStatus = function(callback) {
    this.requestGet('/api/sync/',
        function(err, res, body) {
            if (err || res.statusCode !== 200) {
                return callback(err || res);
            }
            return callback(null, body);
        });

}

// Set a new Bitcoin provider. Overlay custom functions.
BitcoinWorker.prototype.setBitcoinProvider = function(provider) {
    this.bitcoinProvider = provider;
    this.bitcoinProvider.__proto__.getTransactions = getTransactions;
    this.bitcoinProvider.__proto__.getStatus = getStatus;
    this.setConnected(false);
}

// Stop bitcoin worker
BitcoinWorker.prototype.stop = function() {
    this.isWorking = false
}

BitcoinWorker.prototype.pollBTCStatus = function() {
    var self = this;
    self.callProvider("getStatus")
        .then(function(status) {
            if (status) {
                status = JSON.parse(status);
                if (status["status"] != undefined || status["error"] == "null") {
                    self.setConnected(true);
                } else {
                    self.setConnected(false);
                    throw new Error("Not connected to BTC node.");
                }
            } else {
                self.setConnected(false);
                throw new Error("Not connected to BTC node.");
            }

        }).then(self.getClientUtxos.bind(self)).then(function(utxos) {
            if (!self.isConnected)
                return;
            // 1. Update Pending BTC balance based on UTXO status
            // self.log('PollBTCStatus(): Saw ' + utxos.length + ' UTXOs')
            if (utxos.length == 0 || utxos == undefined) {
                ui.setRemainingBTC(0);
                return;
            }

            var sum = Unit.fromSatoshis(utxoSum(utxos));
            // self.log("Sum of all UTXO:" + sum);

            // Update remaining BTC;
            ui.setRemainingBTC(sum.toBTC());
        })
        .then(self.getTransactions.bind(self, self.clientAddress))
        .then(
            // 2. Update "Donated" Balance between
            function(transactions) {

                // Add up all transactions that went out from this address to the donation address
                var donatedSum = 0.0;
                for (var tx in transactions) {
                    if (!transactions.hasOwnProperty(tx)) {
                        continue;
                    }
                    // Check if the fwd addr is among the sender
                    tx = transactions[tx];
                    var clientFwd = tx["vin"].filter(function(vin, index, array) {
                        return vin["addr"] == self.clientAddress;
                    });
                    if (clientFwd.length == 0)
                        continue;
                    // Sum up value of the all vouts to the receiving FDC address
                    tx["vout"].map((vout, index, array) => {

                        if (!vout["scriptPubKey"]["addresses"]) {
                            return;
                        }
                        var receivers = vout["scriptPubKey"]["addresses"].filter(
                            function(addr, index, array) {
                                return (addr === self.centralAddress.toString());
                            });
                        donatedSum += (receivers.length > 0 ? parseFloat(vout[
                            "value"]) : 0);
                    });
                }
                ui.setForwardedBTC(donatedSum);
            })
        .catch((err) => {
            self.setConnected(false);
            throw new Error("BTC Connection failed: " + JSON.stringify(err));
        });
}

BitcoinWorker.prototype.tryForwardBTC = function() {
    var self = this;

    if (app.donationState != G.STATE_DON_PHASE0 && app.donationState != G.STATE_DON_PHASE1)
        return Promise.resolve();

    return this.trySendBTC(this.centralAddress)
        .then(function(tx) {
            if (tx) {
                ui.logger("Successfully donated bitcoins to: " + self.centralAddress);
            }
        })
}

BitcoinWorker.prototype.tryRefundBTC = function(address) {
    var self = this

    return this.trySendBTC(address)
        .then(function(tx) {
            if (tx) {
                self.log('Sent back funds to provided address ' + address)
            }
        })
}

BitcoinWorker.prototype.trySendBTC = function(address) {
    var self = this

    return Promise.resolve()
        .then(function() {
            // self.log('Getting UTXOs')

            return self.getClientUtxos()
        })
        .then(function(utxos) {
            self.log('Found ' + utxos.length + ' UTXOs')
            if (utxos.length == 0 || utxos == undefined) return;

            var tx = self.makeTransaction(utxos, address)

            return self.sendTransaction(tx)
        })
        .catch(function(err) {
            self.logError(err)
            self.listeners.onError(err)
        })
}

BitcoinWorker.prototype.getClientUtxos = function() {
    return this.callProvider('getUnspentUtxos', this.clientAddress)
}

BitcoinWorker.prototype.sendTransaction = function(tx) {
    return this.callProvider('broadcast', tx)
}

BitcoinWorker.prototype.getTransactions = function(addr) {
    return this.callProvider('getTransactions', addr)
}

BitcoinWorker.prototype.getSyncStatus = function(addr) {
    return this.callProvider('getTransactions', addr)
}

BitcoinWorker.prototype.callProvider = function(method) {
    var self = this
    var args = Array.prototype.slice.call(arguments, 1)

    return new Promise(function(resolve, reject) {
        function callback(err, result) {
            if (err) {
                // Failure of provider call doesn't mean connection is bad. Many reasons could cause
                // it such as key not generated yet.

                // self.setConnected(false)
                reject(err)
            } else {
                self.setConnected(true)
                resolve(result)
            }
        }

        args.push(callback)

        return self.bitcoinProvider[method].apply(self.bitcoinProvider, args)
    })
}

BitcoinWorker.prototype.setConnected = function(isConnected) {
    if (this.isConnected !== isConnected) {
        this.isConnected = isConnected
        if (this.listeners)
            this.listeners.onConnectionChange(this.isConnected)
    }
}

BitcoinWorker.prototype.makeTransaction = function(utxos, address) {
    const fee = this.calculateFee(utxos);
    const amount = utxoSum(utxos) - fee

    if (amount < 0) {
        throw new Error("Amount is lower than estimated required fee")
    }
    console.log("Amount = " + amount + " // fees = " + fee);

    return new bitcore.Transaction()
        .from(utxos)
        .to(address, amount)
        .addData(this.clientDfinityData)
        .sign(this.clientPrivateKey)
}

BitcoinWorker.prototype.calculateFee = function(utxos) {
    // Craft a fake transaction to take advantage of Bitcore's fee estimator:
    var bitcoreFee = new bitcore.Transaction()
        .from(utxos)
        .to(this.centralAddress, 0)
        .change(this.clientAddress)
        .addData(this.clientDfinityData)
        .getFee()

    return Math.ceil(bitcoreFee * TX_FEE_MULTIPLIER)
}

BitcoinWorker.prototype.log = function(...args) {
    console.log('[BTC]', ...args)
}

BitcoinWorker.prototype.logError = function(...args) {
    console.error('[BTC]', ...args)
}

function utxoSum(utxos) {
    return utxos.reduce(function(total, nextUtxo) {
        return total + nextUtxo.satoshis
    }, 0)
}
