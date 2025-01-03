verp.define('point_of_sale.keyboard', function (require) {
"use strict";

var Widget = require('web.Widget');

// ---------- OnScreen Keyboard Widget ----------
// A Widget that displays an onscreen keyboard.
// There are two options when creating the widget :
// 
// * 'keyboardModel' : 'simple' (default) | 'full' 
//   The 'full' emulates a PC keyboard, while 'simple' emulates an 'android' one.
//
// * 'inputSelector  : (default: '.searchbox input') 
//   defines the dom element that the keyboard will write to.
// 
// The widget is initially hidden. It can be shown with this.show(), and is 
// automatically shown when the inputSelector gets focused.

var OnscreenKeyboardWidget = Widget.extend({
    template: 'OnscreenKeyboardSimple', 
    init: function(parent, options){
        this._super(parent,options);
        options = options || {};

        this.keyboardModel = options.keyboardModel || 'simple';
        if(this.keyboardModel === 'full'){
            this.template = 'OnscreenKeyboardFull';
        }

        this.inputSelector = options.inputSelector || '.searchbox input';
        this.$target = null;

        //Keyboard state
        this.capslock = false;
        this.shift    = false;
        this.numlock  = false;
    },
    
    connect : function(target){
        var self = this;
        this.$target = $(target);
        this.$target.focus(function(){self.show();});
    },
    generateEvent: function(type,key){
        var event = document.createEvent("KeyboardEvent");
        var initMethod =  event.initKeyboardEvent ? 'initKeyboardEvent' : 'initKeyEvent';
        event[initMethod](  type,
                            true, //bubbles
                            true, //cancelable
                            window, //viewArg
                            false, //ctrl
                            false, //alt
                            false, //shift
                            false, //meta
                            ((typeof key.code === 'undefined') ? key.char.charCodeAt(0) : key.code),
                            ((typeof key.char === 'undefined') ? String.fromCharCode(key.code) : key.char)
                        );
        return event;

    },

    // Write a character to the input zone
    writeCharacter: function(character){
        var input = this.$target[0];
        input.dispatchEvent(this.generateEvent('keypress',{char: character}));
        if(character !== '\n'){
            input.value += character;
        }
        input.dispatchEvent(this.generateEvent('keyup',{char: character}));
    },
    
    // Removes the last character from the input zone.
    deleteCharacter: function(){
        var input = this.$target[0];
        input.dispatchEvent(this.generateEvent('keypress',{code: 8}));
        input.value = input.value.substr(0, input.value.length -1);
        input.dispatchEvent(this.generateEvent('keyup',{code: 8}));
    },
    
    // Clears the content of the input zone.
    deleteAllCharacters: function(){
        var input = this.$target[0];
        if(input.value){
            input.dispatchEvent(this.generateEvent('keypress',{code: 8}));
            input.value = "";
            input.dispatchEvent(this.generateEvent('keyup',{code: 8}));
        }
    },

    // Makes the keyboard show and slide from the bottom of the screen.
    show:  function(){
        $('.keyboard-frame').show().css({'height':'235px'});
    },
    
    // Makes the keyboard hide by sliding to the bottom of the screen.
    hide:  function(){
        $('.keyboard-frame')
            .css({'height':'0'})
            .hide();
        this.reset();
    },
    
    //What happens when the shift key is pressed : toggle case, remove capslock
    toggleShift: function(){
        $('.letter').toggleClass('uppercase');
        $('.symbol span').toggle();
        
        this.shift = (this.shift === true) ? false : true;
        this.capslock = false;
    },
    
    //what happens when capslock is pressed : toggle case, set capslock
    toggleCapsLock: function(){
        $('.letter').toggleClass('uppercase');
        this.capslock = true;
    },
    
    //What happens when numlock is pressed : toggle symbols and numlock label 
    toggleNumLock: function(){
        $('.symbol span').toggle();
        $('.numlock span').toggle();
        this.numlock = (this.numlock === true ) ? false : true;
    },

    //After a key is pressed, shift is disabled. 
    removeShift: function(){
        if (this.shift === true) {
            $('.symbol span').toggle();
            if (this.capslock === false) $('.letter').toggleClass('uppercase');
            
            this.shift = false;
        }
    },

    // Resets the keyboard to its original state; capslock: false, shift: false, numlock: false
    reset: function(){
        if(this.shift){
            this.toggleShift();
        }
        if(this.capslock){
            this.toggleCapsLock();
        }
        if(this.numlock){
            this.toggleNumLock();
        }
    },

    //called after the keyboard is in the DOM, sets up the key bindings.
    start: function(){
        var self = this;

        //this.show();


        $('.close-button').click(function(){ 
            self.deleteAllCharacters();
            self.hide(); 
        });

        // Keyboard key click handling
        $('.keyboard li').click(function(){
            
            var $this = $(this),
                character = $this.html(); // If it's a lowercase letter, nothing happens to this variable
            
            if ($this.hasClass('left-shift') || $this.hasClass('right-shift')) {
                self.toggleShift();
                return false;
            }
            
            if ($this.hasClass('capslock')) {
                self.toggleCapsLock();
                return false;
            }
            
            if ($this.hasClass('delete')) {
                self.deleteCharacter();
                return false;
            }

            if ($this.hasClass('numlock')){
                self.toggleNumLock();
                return false;
            }
            
            // Special characters
            if ($this.hasClass('symbol')) character = $('span:visible', $this).html();
            if ($this.hasClass('space')) character = ' ';
            if ($this.hasClass('tab')) character = "\t";
            if ($this.hasClass('return')) character = "\n";
            
            // Uppercase letter
            if ($this.hasClass('uppercase')) character = character.toUpperCase();
            
            // Remove shift once a key is clicked.
            self.removeShift();

            self.writeCharacter(character);
        });
    },
});

return {
    OnscreenKeyboardWidget: OnscreenKeyboardWidget,
};

});
