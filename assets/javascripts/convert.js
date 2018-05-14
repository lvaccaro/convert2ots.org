'use strict'
//const OpenTimestamps = require('javascript-opentimestamps');
//const ConvertOTS = require('/src/convert2ots.js');

const OpenTimestamps = window.OpenTimestamps;
const ConvertOTS = window.convert2ots;
const Tools = ConvertOTS.Tools;
const DetachedTimestampFile = OpenTimestamps.DetachedTimestampFile;
const Timestamp = OpenTimestamps.Timestamp;
const Context = OpenTimestamps.Context;
const Ops = OpenTimestamps.Ops;

// FILE

$( document ).ready(function() {


    $('#document_holder').on('drop', function (event) {
        event.preventDefault();
        event.stopPropagation();
        $(this).removeClass('hover');
        var f = event.originalEvent.dataTransfer.files[0];
        if (f === undefined){
            return;
        }
        Document.setFile(f);
        Document.show();
        Document.upload(f);
        return false;
    });
    $('#document_holder').on('dragover', function (event) {
        event.preventDefault();
        event.stopPropagation();
        $(this).addClass('hover');
        return false;
    });
    $('#document_holder').on('dragleave', function (event) {
        event.preventDefault();
        event.stopPropagation();
        $(this).removeClass('hover');
        return false;
    });
    $('#document_holder').click(function (event) {
        console.log('document_holder : click');
        event.preventDefault();
        event.stopPropagation();
        document.getElementById('document_input').click();
        return false;
    });
    $('#document_input').change(function (event) {
        var f = event.target.files[0];
        if (f === undefined){
            return;
        }
        Document.setFile(f);
        Document.show();
        Document.upload(f);
    });
    $('#convertButton').click(function (event) {
        if (Document.output) {
            download(Document.filename, Document.output);
        }
    });
    $('#infoButton').click(function (event) {
        if (Document.output) {
            location.href = "https://opentimestamps.org/info/?"+bytesToHex(Document.output);
        }
    });
});



/*
 * GLOBAL PROOF OBJ
 */
var Document = {
    setFile : function(file){
        this.data = undefined;
        this.filename = file.name;
        this.filesize = file.size;
    },
    setArray : function(buffer){
        this.data = buffer;
        this.filename = undefined;
        this.filesize = undefined;
    },
    upload: function (file) {
        // Read and crypt the file
        var self = this;
        var reader = new FileReader();
        reader.onload = function (event) {
            var data = event.target.result;
            self.data = String(String(data));
            self.filename = file.name;
            self.filesize = file.size;
            console.log('proof: ' + self.data);
            self.show();
            // start conversion
            run(Document.filename, JSON.parse(Document.data));
        };
        reader.readAsBinaryString(file);
    },
    show: function() {
        hideMessages();
        if (this.filename) {
            $(".result-description").html(this.filename);
        } else {
            $(".result-description").html("Unknown name");
        }
        if (this.filesize) {
            $(".result-description").append(" " + humanFileSize(this.filesize, true));
        } else {
            $(".result-description").append(" " + humanFileSize(this.data.length, true));
        }
    },
    progressStart : function(){
        this.percent = 0;

        var self = this;
        this.interval = setInterval(() => {
            self.percent += parseInt(self.percent/3) + 1;
        if (self.percent > 100) {
            self.percent = 100;
        }
        loading(self.percent + ' %', 'Verify')
    }, 100);
    },
    progressStop : function(){
        clearInterval(this.interval);
    }
};

// RUN CONVERT TO OTS
function run(filename, chainpoint){
    loading("Converting","Uploading ad converting receipt on progress...");


// Check chainpoint file
    const SupportedFormat = {CHAINPOINTv2: 1, CHAINPOINTv3: 2};
    let format = '';
    if (ConvertOTS.checkValidHeaderChainpoint2(chainpoint)) {
        format = SupportedFormat.CHAINPOINTv2;
        console.log('Chainpoint v2 file format');
        console.log('File type: ' + chainpoint.type);
        console.log('Target hash: ' + chainpoint.targetHash);
    } else if (ConvertOTS.checkValidHeaderChainpoint3(chainpoint)) {
        format = SupportedFormat.CHAINPOINTv3;
        console.log('Chainpoint v3 file format');
        console.log('File type: ' + chainpoint.type);
        console.log('Target hash: ' + chainpoint.hash);
    } else {
        failure('Support only timestamps with attestations');
        return;
    }

    // Check and generate merkle tree
    let merkleRoot = {};
    let calendarRoot = {};

    if (format === SupportedFormat.CHAINPOINTv2) {
        merkleRoot = ConvertOTS.calculateMerkleRootChainpoint2(chainpoint.targetHash, chainpoint.proof);
        if (merkleRoot !== chainpoint.merkleRoot) {
            console.log('Invalid merkle root');
            process.exit(1);
        }
    } else if (format === SupportedFormat.CHAINPOINTv3) {
        chainpoint.branches.forEach(branch => {
            if (branch.label === 'cal_anchor_branch') {
            calendarRoot = ConvertOTS.calculateMerkleRootChainpoint3(chainpoint.hash, branch.ops);
            branch.branches.forEach(subBranch => {
                if (subBranch.label === 'btc_anchor_branch') {
                    merkleRoot = ConvertOTS.calculateMerkleRootChainpoint3(calendarRoot, subBranch.ops);
                }
            });
            }
        });
    }

    // Check and migrate attestations of the proof
    if (format === SupportedFormat.CHAINPOINTv2) {
        /* Chainpoint v2: the attestation is anchor to op_return of the transaction.
         * In order to resolve the full attestation to the merkle root of the block
         * we use a lite verification (with the insight) or bitcoin node. */
        let timestamp = {};
        try {
            timestamp = ConvertOTS.migrationChainpoint2(chainpoint.targetHash, chainpoint.proof);
            if (timestamp === undefined) {
                throw String('Invalid timestamp');
            }
        } catch (err) {
            failure('Building error: ' + err);
            return;
        }
        // Add intermediate unknow attestation
        try {
            ConvertOTS.migrationAttestationsChainpoint2(chainpoint.anchors, timestamp);
            // Console.log(timestamp.strTree(0, 1));
        } catch (err) {
            failure('Attestation error');
            return;
        }

        // Resolve unknown attestations
        const promises = [];
        const stampsAttestations = timestamp.directlyVerified();
        stampsAttestations.forEach(subStamp => {
            subStamp.attestations.forEach(attestation => {
                // Console.log('Find op_return: ' + Tools.bytesToHex(attestation.payload));
                const txHash = Tools.bytesToHex(attestation.payload);
                promises.push(ConvertOTS.resolveAttestation(txHash, subStamp, true));
            });
        });

        // Callback with the full attestation
        Promise.all(promises.map(Tools.hardFail))
            .then(() => {
                // Print attestations
                const attestations = timestamp.getAttestations();
                attestations.forEach(attestation => {
                    console.log('OTS attestation: ' + attestation.toString());
                });
                // Store to file
                saveTimestamp(filename, timestamp);
            }).catch(err => {
                failure('Resolve attestation error: ' + err);
                return;
            });

    } else if (format === SupportedFormat.CHAINPOINTv3) {

        /* Chainpoint v3: the attestation is anchor to block height.
         * In order to resolve to check the merkle root of the block height,
         * we use a lite verification (with the insight) or bitcoin node. */

        let timestampMerkleRoot = {};
        let timestampCalRoot = {};
        chainpoint.branches.forEach(branch => {
            if (branch.label === 'cal_anchor_branch') {
                timestampCalRoot = ConvertOTS.migrationChainpoint3(chainpoint.hash, branch.ops);
                branch.branches.forEach(subBranch => {
                    if (subBranch.label === 'btc_anchor_branch') {
                        timestampMerkleRoot = ConvertOTS.migrationChainpoint3(calendarRoot, subBranch.ops);
                    }
                });
            }
        });

        // Concat temporany calendar proof with bitcoin merkle proof
        ConvertOTS.concatTimestamp(timestampCalRoot, timestampMerkleRoot);

        // Print attestations
        const attestations = timestampCalRoot.getAttestations();
        attestations.forEach(attestation => {
            console.log('OTS attestation: ' + attestation.toString());
        });

        // Store to file
        try {
            saveTimestamp(filename, timestampCalRoot);
        } catch (err) {
            failure('Saving ots error');
            return;
        }
    }
}


        /*


    // Check chainpoint file
    if (chainpoint['@context'] !== 'https://w3id.org/chainpoint/v2') {
        failure('Support only chainpoint v2');
        return;
    }
    if (chainpoint.type !== 'ChainpointSHA256v2') {
        failure('Support only ChainpointSHA256v2');
        return;
    }
    if (chainpoint.anchors === undefined) {
        failure('Support only timestamps with attestations');
        return;
    }


    // Output information
    console.log('File type: ' + chainpoint.type);
    console.log('Target hash: ' + chainpoint.targetHash);

    // Check valid chainpoint merkle
    const merkleRoot = ConvertOTS.calculateMerkleRoot(chainpoint.targetHash, chainpoint.proof);
    if (merkleRoot !== chainpoint.merkleRoot) {
        failure('Invalid merkle root');
        return;
    }

    // Migrate proof
    let timestamp;
    try {
        timestamp = ConvertOTS.migrationMerkle(chainpoint.targetHash, chainpoint.proof);
        // Console.log(timestamp.strTree(0, 1));
    } catch (err) {
        failure('Building error');
        return;
    }

    // Migrate attestation
    try {
        ConvertOTS.migrationAttestations(chainpoint.anchors, timestamp);
        // Console.log(timestamp.strTree(0, 1));
    } catch (err) {
        failure('Attestation error');
        return;
    }


    // Resolve unknown attestations
    const promises = [];
    const stampsAttestations = timestamp.directlyVerified();
    stampsAttestations.forEach(subStamp => {
        subStamp.attestations.forEach(attestation => {
            console.log('Find op_return: ' + Tools.bytesToHex(attestation.payload));
            const txHash = Tools.bytesToHex(attestation.payload);
            promises.push(ConvertOTS.resolveAttestation(txHash, subStamp, true));
        });
    });

    Promise.all(promises.map(Tools.hardFail))
        .then(() => {
            // Print attestations
            const attestations = timestamp.getAttestations();
            attestations.forEach(attestation => {
                console.log('OTS attestation: ' + attestation.toString());
            });

            // Store to file
            const detached = new DetachedTimestampFile(new Ops.OpSHA256(), timestamp);
            const ctx = new Context.StreamSerialization();
            detached.serialize(ctx);
            Document.output = ctx.getOutput();
            success('Convert success!');
        })
        .catch(err => {
            failure('Resolve attestation error: ' + err);
            return;
        });
}
*/

// Save ots file
function saveTimestamp(filename, timestamp) {
    //convert timestamp
    var x = new OpenTimestamps.Timestamp([]);
    x.msg = timestamp.msg;
    x.attestations = timestamp.attestations;
    x.ops = timestamp.ops;
    const detached = new DetachedTimestampFile(new Ops.OpSHA256(), x);
    const ctx = new Context.StreamSerialization();
    detached.serialize(ctx);
    success('Convert success!');
    Document.output = ctx.getOutput();
    download(filename, ctx.getOutput());
}

/*
 * COMMON FUNCTIONS
 */
// Human file size
function humanFileSize(bytes, si) {
    var thresh = si ? 1000 : 1024;
    if (Math.abs(bytes) < thresh) {
        return bytes + ' B';
    }
    var units = si
        ? ['kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
        : ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
    var u = -1;
    do {
        bytes /= thresh;
        ++u;
    } while (Math.abs(bytes) >= thresh && u < units.length - 1);
    return bytes.toFixed(1) + ' ' + units[u];
}

function bytesToHex (bytes) {
    const hex = [];
    for (var i = 0; i < bytes.length; i++) {
        hex.push((bytes[i] >>> 4).toString(16));
        hex.push((bytes[i] & 0xF).toString(16));
    }
    return hex.join('');
};

function string2Bin(str) {
    var result = [];
    for (var i = 0; i < str.length; i++) {
        result.push(str.charCodeAt(i));
    }
    return result;
}

// Download file
function download(filename, text) {
    var blob = new Blob([text], {type: "octet/stream"});
    saveAs(blob,  filename + '.ots');
}


// Alerts
function loading(title, text){
    console.log(text);
    $('#stamp .statuses_hashing .statuses-title').html(title);
    $('#stamp .statuses_hashing .statuses-description').html(text);
    $('#stamp .statuses_hashing').show();
}
function success(text){
    console.log(text);
    hideMessages();
    $('#stamp .statuses_success .statuses-title').html("SUCCESS!");
    $('#stamp .statuses_success .statuses-description').html(text);
    $('#stamp .statuses_success').show();

    $('#convertButton').removeClass("disabled");
    $('#infoButton').removeClass("disabled");
}
function failure(text){
    console.log(text);
    hideMessages();
    $('#stamp .statuses_failure .statuses-title').html("FAILURE!");
    $('#stamp .statuses_failure .statuses-description').html(text);
    $('#stamp .statuses_failure').show();
}

function hideMessages() {
    $('#stamp .statuses_hashing').hide();
    $('#stamp .statuses_failure').hide();
    $('#stamp .statuses_success').hide();
}
