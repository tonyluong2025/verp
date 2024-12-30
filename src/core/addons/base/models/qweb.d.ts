import { FrozenSet } from "../../../helper/collections";
import { XmlError } from "../../../helper/errors";
import { AbstractModel } from '../../../models';

declare class QWebException extends XmlError {
     constructor(message, qweb, options, error?: any, kw?: { template?: any, path?: any, code?: any, line?: number });
}

declare class QWebCodeFound extends XmlError { }

/**
 * Remove any common leading whitespace from every line in `text`.

  This can be used to make triple-quoted strings line up with the left
  edge of the display, while still presenting them in the source code
  in indented form.

  Note that tabs and spaces are both treated as whitespace, but they
  are not equal: the lines "  hello" and "\\thello" are
  considered to have no common leading whitespace.

  Entirely blank lines are normalized to a newline character.
 * @param text 
 * @returns 
 */
declare function dedent(text: string);

declare function _debug(msg, template);

/**
 * Adds 'prefix' to the beginning of selected lines in 'text'.

  If 'predicate' is provided, 'prefix' will only be added to the lines
  where 'predicate(line)' is true. If 'predicate' is not provided,
  it will default to adding 'prefix' to all non-empty lines that do not
  consist solely of whitespace characters.
 * @param text 
 * @param prefix 
 * @param predicate 
 * @returns 
 */
declare function _indent(text: string, prefix: string, predicate?: any);

declare function _subNsmap(ns1: {}, ns2: {})

declare function _joinCode(codeLines: string | string[], num?: number)

declare const _whitespaceOnlyRe: RegExp;

declare const _leadingWhitespaceRe: RegExp;

declare const _FORMAT_REGEX: RegExp;

declare const _VARNAME_REGEX: RegExp;

declare const _allowedGlobals: RegExp;

declare class QWeb extends AbstractModel {
     // A void element is an element whose content model never allows it to have contents under any circumstances. Void elements can have attributes.
     _voidElements: FrozenSet<any>;
     // _availableObjects builtins is not security safe (it's dangerous), is overridden by irQweb to only expose the safeEval builtins.
     _nameGen: any;

     _availableObjects: {};

     _allowedKeywords: any[];

     // values for running time
     _prepareValues(values, options?: {}): {};

     /**
      * Prepare the global context that will sent to eval the qweb generated
       code.
       :param globals_dict: template global values use in compiled code
       :param options: frozen dict of compilation parameters.
      * @param globalsDict 
      * @param options 
      * @returns 
      */
     _prepareGlobals(globalsDict?: {}, options?: {}): {}

     // compute helpers
     /**
      * Add an item (converts to a str) to the list.
               This will be concatenated and added during a call to the
               `_flushText` method. This makes it possible to return only one
               yield containing all the parts.
      * @param text 
      * @param options 
      */
     _appendText(text?: string, options?: {}): void;

     /**
      * Concatenate all the textual chunks added by the `_appendText`
           method into a single yield.
      * @param options 
      * @param indent 
      * @returns 
      */
     _flushText(options?: {}, indent?: number): string[];

     _indent(code: string, indent?: number): string;

     _makeName(prefix?: string): string;

     // order

     /**
      * List all supported directives in the order in which they should be
           evaluated on a given element. For instance, a node bearing both
           ``foreach`` and ``if`` should see ``foreach`` executed before ``if`` aka
           .. code-block:: xml
               <el t-foreach="foo" t-as="bar" t-if="bar">
           should be equivalent to
           .. code-block:: xml
               <t t-foreach="foo" t-as="bar">
                   <t t-if="bar">
                       <el>
           then this method should return ``['foreach', 'if']``.
      * @returns 
      */
     _directivesEvalOrder(): string[];

     /**
      * Test whether the given element is purely static, i.e. (there
           are no t-* attributes), does not require dynamic rendering for its
           attributes.
      * @param el 
      * @param options 
      * @returns 
      */
     _isStaticNode(el?: Element, options?: {}): boolean;

     _debugTrace(logger, options): void;

     // method called by computing code
     _postProcessingAttr(localName: any, attributes?: {}, options?: {}): Promise<{}>;

     //compile
     _compileFormat(expr: string): string;

     /**
      * * Transform the list of token coming into a javascript instruction in
       textual form by adding the namepaces for the dynamic values.
   
       Example: `5 + a + b.c` to be `5 + values.get('a') + values['b'].c`
       Unknown values are considered to be None, but using `values['b']`
       gives a clear error message in cases where there is an attribute for
       example (have a `KeyError: 'b'`, instead of `AttributeError: 'NoneType'
       object has no attribute 'c'`).
   
      * @param tokens 
      * @param allowedKeys 
      * @param argumentNames 
      * @param raiseOnMissing 
      * @returns 
      */
     _compileExprTokens(tokens, allowedKeys: string[], argumentNames?: any, raiseOnMissing?: boolean): string;

     _compileExpr(expr: string, raiseOnMissing?: boolean): string;

     _compileBool(attr: any, defaultValue?: any): boolean;

     _compileToStr(expr: any): string;

     _compileAttributes(options: {}, indent?: number): string[];

     _compileStaticAttributes(el: Element, options?: {}, indent?: number, attrAlreadyCreated?: boolean): string[];

     _compileDynamicAttributes(el: Element, options?: {}, indent?: number, attrAlreadyCreated?: boolean): string[];

     _compileAllAttributes(el: Element, options?: {}, indent?: number, attrAlreadyCreated?: boolean): string[];

     _compileTagOpen(el: Element, options?: {}, indent?: number, attrAlreadyCreated?: boolean): string[];

     _compileTagClose(el: Element, options?: {}, indent?: number, attrAlreadyCreated?: boolean): string[];

     /**
      * Compile the given element into javascript code.
   
       The t-* attributes (directives) will be converted to a javascript instruction. If there
       are no t-* attributes, the element will be considered static.
   
       Directives are compiled using the order provided by the
       ``_directivesEvalOrder`` method (an create the
       ``options['iterDirectives']`` iterator).
       For compilation, the directives supported are those with a
       compilation method ``_compileDirective_*``
   
     :return: list of str
       * @param el 
       * @param _options 
       * @param indent 
       * @returns 
       */
     _compileNode(el: Element, options?: {}, indent?: number): Promise<string[]>;

     _compileDirectives(el: Element, options?: {}, indent?: number): Promise<string[]>;

     /**
      * Compile a purely static element into a list of str.
      * @param el 
      * @param options 
      * @param indent 
      */
     _compileStaticNode(el: Element, options?: {}, indent?: number): Promise<string[]>;

     // compile directives
     _compileDirective(el: Element, options?: {}, directive?: string, indent?: number): Promise<string[]>;

     _compileDirectiveDebug(el: Element, options?: {}, indent?: number): Promise<string[]>;

     /**
      * compile t-options and add to the dict the t-options-xxx values
      * @param el 
      * @param options 
      * @param indent 
      * @returns 
      */
     _compileDirectiveOptions(el: Element, options?: {}, indent?: number): Promise<string[]>;

     _compileDirectiveTag(el: Element, options?: {}, indent?: number): Promise<string[]>;

     _compileDirectiveSet(el: Element, options?: {}, indent?: number): Promise<string[]>;

     _compileDirectiveContent(el: Element, options?: {}, indent?: number): Promise<string[]>;

     _compileDirectiveElse(el: Element, options?: {}, indent?: number): Promise<string[]>;

     _compileDirectiveElif(el: Element, options?: {}, indent?: number): Promise<string[]>;

     _compileDirectiveIf(el: Element, options?: {}, indent?: number): Promise<string[]>;

     /**
      * Compile `t-foreach` expressions into a javascript code as a list of
       strings.
   
       `t-as` is used to define the key name.
       `t-foreach` compiled value can be an iterable, an dictionary or a
       number.
   
       The code will contain loop `for` that wrap the rest of the compiled
       code of this element.
       Some key into values dictionary are create automatically:
           *_size, *_index, *_value, *_first, *_last, *_odd, *_even, *_parity
      * @param el 
      * @param options 
      * @param indent 
      */
     _compileDirectiveForeach(el: Element, options?: {}, indent?: number): Promise<string[]>;

     _compileDirectiveOut(el: Element, options?: {}, indent?: number): Promise<string[]>;

     _compileDirectiveEsc(el: Element, options?: {}, indent?: number): Promise<string[]>;

     _compileDirectiveRaw(el: Element, options?: {}, indent?: number): Promise<string[]>;

     /**
      * Compile `t-field` expressions into a javascript code as a list of
       strings.
   
       The compiled code will call ``_get_field`` method at rendering time
       using the type of value supplied by the field. This behavior can be
       changed with `t-options-widget` or `t-options={'widget': ...}.
   
       The code will contain evalution and rendering of the compiled value
       value from the record field. If the compiled value is None or false,
       the tag is not added to the render
       (Except if the widget forces rendering or there is default content.).
      * @param el 
      * @param options 
      * @param indent 
      * @returns 
      */
     _compileDirectiveField(el: Element, options?: {}, indent?: number): Promise<string[]>;

     /**
      * Take care of part of the compilation of `t-out` and `t-field` (and
           the technical directive `t-tag). This is the part that takes care of
           whether or not created the tags and the default content of the element.
      * @param el 
      * @param options 
      * @param indent 
      * @param without_attributes 
      */
     _compileWidgetValue(el: Element, options?: {}, indent?: number, withoutAttributes?: boolean): Promise<string[]>;

     /**
      * Compile `t-call` expressions into a javascript code as a list of
           strings.
   
           `t-call` allow formating string dynamic at rendering time.
           Can use `t-options` used to call and render the sub-template at
           rendering time.
           The sub-template is called with a copy of the rendering values
           dictionary. The dictionary contains the key 0 coming from the
           compilation of the contents of this element
   
           The code will contain the call of the template and a function from the
           compilation of the content of this element.
      * @param el 
      * @param options 
      * @param indent 
      * @returns 
      */
     _compileDirectiveCall(el: Element, options?: {}, indent?: number): Promise<string[]>;

     /**
      * Compile the given template into a rendering function (generator)::
           render(qweb, values)
       where ``qweb`` is a QWeb instance and ``values`` are the values to render.
      * @param template 
      * @param options 
      */
     _compile(template: any, options: {}): Promise<(idOrXmlid: any, options: {}) => AsyncGenerator<any, void, unknown>>;


     _render(template: any, values?: {}, options?: {}): Promise<string>;

     /**
      * Load a given template and return a tuple ``[xml, ref]``` 
      * @param template 
      * @param options 
      * @returns 
      */
     _load(template: any, options?: {}): Promise<[any, number | null]>;

     /**
      * Retrieve the given template, and return it as a tuple ``(etree,
       xml, ref)``, where ``element`` is an etree, ``document`` is the
       str document that contains ``element``, and ``ref`` if the uniq
       reference of the template (id, t-name or template).
   
       :param template: template identifier, name or etree
       :param options: used to compile the template (the dict available for
           the rendering is frozen)
           ``load`` (function) overrides the load method
      * @param template 
      * @param options 
      */
     _getTemplate(template, options?: {}): Promise<[Element, string, string]>;

     /**
      * Method called at compile time to return the field value.
   
      * @param record 
      * @param fieldName 
      * @param expression 
      * @param tagName 
      * @param field_options 
      * @param options 
      * @param values 
      * @returns tuple
      *   dict: attributes
             * string or null: content
             * boolean: forceDisplay display the tag if the content and defaultContent are null
      */
     _getField(record, fieldName, expression, tagName, fieldOptions, options, values): Promise<any[]>;

     /**
      * Method called at compile time to return the widget value.
   
      * @param value 
      * @param expression 
      * @param tagName 
      * @param fieldOptions 
      * @param options 
      * @param values 
      * @returns tuple
      *   dict: attributes
             * string or null: content
             * boolean: forceDisplay display the tag if the content and defaultContent are null
      */
     _getWidget(value, expression, tagName, fieldOptions, options, values): Promise<any[]>;
}
