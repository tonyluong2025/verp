verp.define('report.utils', function (require) {
'use strict';

function getProtocolFromUrl (url) {
    var a = document.createElement('a');
    a.href = url;
    return a.protocol;
}

function getHostFromUrl (url) {
    var a = document.createElement('a');
    a.href = url;
    return a.host;
}

function buildOrigin (protocol, host) {
    return protocol + '//' + host;
}

return {
    'getProtocolFromUrl': getProtocolFromUrl,
    'getHostFromUrl': getHostFromUrl,
    'buildOrigin': buildOrigin,
};

});
