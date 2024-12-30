/** @verp-module **/

// import { registerCleanup } from "@web/../tests/helpers/cleanup";

const { Component, useState, mount, xml } = owl;

class Greeter extends Component {
    static template = "Greeter";
    
    setup() {
        this.state = useState({ word: 'Hello' });
        console.log('This is Greeter!');
    }

    toggle() {
        this.state.word = this.state.word === 'Hi' ? 'Hello' : 'Hi';
    }
}

// Main root component
class Root extends Component {
    static components = { Greeter };
    static template = "Root"

    setup() {
        this.state = useState({ name: 'World'});
        console.log('This is Root!');
    }
}

console.log('Test Tony');
// mount(Root, document.body, { dev: true });
