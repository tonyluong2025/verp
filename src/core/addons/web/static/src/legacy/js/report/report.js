verp.define('report', function (require) {
'use strict';

require('web.domReady');
var utils = require('report.utils');

if (window.self === window.top) {
    return;
}

$(document.body)
    .addClass('o-in-iframe')
    .addClass('container-fluid')
    .removeClass('container');

var webBaseUrl = window.origin;
var trustedHost = utils.getHostFromUrl(webBaseUrl);
var trustedProtocol = utils.getProtocolFromUrl(webBaseUrl);
var trustedOrigin = utils.buildOrigin(trustedProtocol, trustedHost);

// Allow sending commands to the webclient
// `doAction` command
$('[res-id][res-model][view-type]')
    .wrap('<a/>')
    .attr('href', '#')
    .on('click', function (ev) {
        ev.preventDefault();
        var action = {
            'type': 'ir.actions.actwindow',
            'viewMode': $(this).attr('view-mode') || $(this).attr('view-type'),
            'resId': Number($(this).attr('res-id')),
            'resModel': $(this).attr('res-model'),
            'views': [
                [$(this).attr('view-id') || false, $(this).attr('view-type')],
            ],
        };
        window.parent.postMessage({
            'message': 'report:doAction',
            'action': action,
        }, trustedOrigin);
    });
});
