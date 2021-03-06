#!/usr/bin/env node
'use strict';

var program = require('commander');
var fs = require('fs');
var Client = require('bitcore-wallet-client');
var bitcore = require('bitcore-lib');
var Message = require('./message');
var sjcl = require('sjcl');
var ttyread = require('ttyread');

var BWS_INSTANCE_URL = 'https://bws.bitpay.com/bws/api';

program
  .usage('<wallet-file> <message-file> <output-file>')
  .description('Sign a message with copay private keys')
  .parse(process.argv);

if(program.args.length !== 3) {
  return program.help();
}

var walletFile = program.args[0];
var messageFile = program.args[1];
var outputFile = program.args[2];

var message = fs.readFileSync(messageFile, 'utf8');
var encryptedString = fs.readFileSync(walletFile, 'utf8');
var outStream = fs.createWriteStream(outputFile);

var decryptedString;
var walletMetadata;
var network;
var networkDerivation;
var threshold;
var path;
var hdPrivateKey;
var clientXPubKeys;
var copayerIndex;

var count = 0;

ttyread('Password: ', {silent: true}, function(err, password) {
  if(err) {
    console.log(err);
    return;
  }

  try {
    decryptedString = sjcl.decrypt(password, encryptedString);
  } catch(e) {
    if(e.message === 'ccm: tag doesn\'t match') {
      console.error('Incorrect Password');
    } else {
      console.error(e.message);
    }

    return;
  }

  walletMetadata = JSON.parse(decryptedString);

  //console.log(walletMetadata);

  if(['BIP44', 'BIP45'].indexOf(walletMetadata.derivationStrategy) === -1) {
    throw new Error('Derivation strategy is not BIP44 or BIP45 (' + walletMetadata.derivationStrategy + ')');
  }

  if(!walletMetadata.compliantDerivation) {
    console.error('WARNING: compliantDerivation = false');
  }

  network = walletMetadata.network;
  networkDerivation = network === 'testnet' ? '1' : '0';
  threshold = walletMetadata.m;

  if(walletMetadata.derivationStrategy === 'BIP44') {
    path = "m/44'/" + networkDerivation + "'/" + walletMetadata.account + "'";
  } else if(walletMetadata.derivationStrategy === 'BIP45') {
    path = "m/45'";
  }

  hdPrivateKey = new bitcore.HDPrivateKey(walletMetadata.xPrivKey).derive(path);

  clientXPubKeys = walletMetadata.publicKeyRing.map(function(ring) {
    return new bitcore.HDPublicKey(ring.xPubKey);
  });

  var client = new Client({
    baseUrl: BWS_INSTANCE_URL,
    verbose: true
  });

  client.import(decryptedString);

  client.getStatus({includeExtendedInfo: true}, function(err, status) {
    if(err) {
      console.error(err);
      return;
    }

    copayerIndex = status.wallet.addressManager.copayerIndex;

    if(walletMetadata.derivationStrategy === 'BIP45' && !copayerIndex) {
      throw new Error('Missing copayerIndex');
    }

    var receiveAddressIndex = status.wallet.addressManager.receiveAddressIndex;
    var changeAddressIndex = status.wallet.addressManager.changeAddressIndex;

    console.log('receiveAddressIndex', receiveAddressIndex);
    console.log('changeAddressIndex', changeAddressIndex);

    var indexPrefix = "m/";

    if(walletMetadata.derivationStrategy === 'BIP45') {
      indexPrefix += copayerIndex + '/';
    }

    outStream.write('[\n');

    // Derive main addresses
    for(var i = 0; i < receiveAddressIndex - 1; i++) {
      processAddress(indexPrefix + '0/' + i, false);
    }

    if(receiveAddressIndex && changeAddressIndex) {
      processAddress(indexPrefix + '0/' + (receiveAddressIndex - 1), false);
    } else if(receiveAddressIndex) {
      processAddress(indexPrefix + '0/' + (receiveAddressIndex - 1), true);
    }

    // Derive change addresses
    for(var i = 0; i < changeAddressIndex - 1; i++) {
      processAddress(indexPrefix + '1/' + i, false);
    }

    if(changeAddressIndex) {
      processAddress(indexPrefix + '1/' + (changeAddressIndex - 1), true);
    }

    outStream.write(']\n');
  });
});


function processAddress(path, last) {
  if(count % 10 === 0) {
    console.log(count);
  }

  var priv = hdPrivateKey.derive(path).privateKey;
  var pub = priv.publicKey;

  var publicKeys = clientXPubKeys.map(function(xPubKey) {
    return xPubKey.derive(path).publicKey.toString();
  });

  if(publicKeys.indexOf(pub.toString()) === -1) {
    throw new Error('Public key mismatch: ' + pub.toString());
  }

  var script = bitcore.Script.buildMultisigOut(publicKeys, walletMetadata.m);
  var address = script.toScriptHashOut().toAddress(bitcore.Networks.get(network)).toString();

  var signature = Message(message).sign(priv);

  var obj = {
    address: address,
    threshold: walletMetadata.m,
    path: path,
    publicKeys: publicKeys,
    signatures: {}
  };

  obj.signatures[pub.toString()] = signature;

  outStream.write(JSON.stringify(obj, null, 2));

  if(!last) {
    outStream.write(',');
  }

  outStream.write('\n');
  count++;
}
