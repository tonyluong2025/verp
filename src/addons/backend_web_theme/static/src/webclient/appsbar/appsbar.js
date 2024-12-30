/** @verp-module **/

// import { useService } from "@web/core/utils/hooks";

const { Component } = owl;

export class AppsBar extends Component { }

Object.assign(AppsBar, {
    template: 'backend_web_theme.AppsBar',
    props: {
        apps: Array,
    },
});

