import assert from 'assert';
import 'reflect-metadata';
import { KeyError } from "../helper/errors";
import { f, isCallable, isInstance, isIterable, partial } from "../tools";
import { getattr, setattr } from "./func";

export type RequestMethod = 'get' | 'post' | 'delete' | 'options' | 'put';

export function returns(model: string, downgrade?: Function, upgrade?: Function): MethodDecorator {
  return (target: any, propertyKey: string) => {
    setattr(target[propertyKey], '_returns', [model, downgrade, upgrade]);
  };
}

export function constrains(...args: any[]): MethodDecorator {
  if (args && isCallable(args[0])) {
    args = args[0];
  }
  return function (target: any, propertyKey: string) {
    setattr(target[propertyKey], '_constrains', args)
  };
}

/**
 * Return a decorator that specifies the field dependencies of a "compute" method (for new-style function fields). Each argument must be a string that consists in a dot-separated sequence of field names::

  static pname = Fields.Char({compute: '_computePname'});

  @api.depends('partnerId.label', 'partnerId.isCompany')
  aync _computePname() {
    for (const record of this) {
      if (await (await record.partnerId).isCompany) {
        await record.set('pname', (await (await record.partnerId).label || '').toUpperCase());
      }
      else {
        await record.set('pname', await (await record.partnerId).label);
      }
    }
  }
  One may also pass a single function as argument. In that case, the dependencies are given by calling the function with the field's model.
 * @param 
 * @param args 
 */
export function depends(...args: any[]) {
  if (args && isCallable(args[0])) {
    args = args[0];
  } else {
    if (args.map((arg: string) => arg.split('.')).some((val: string[]) => val.includes('id'))) {
      throw new Error(`NotImplementedError("Compute method cannot depend on field 'id'.")`);
    }
  }
  return function (target: any, propertyKey?: string) {
    setattr(target[propertyKey], '_depends', args);
  };
}

/**
 * Return a decorator that specifies the context dependencies of a
    non-stored "compute" method.  Each argument is a key in the context's
    dictionary::

        static price = Fields.Float({compute: '_computeProductPrice'});

        @api.dependsContext('pricelist')
        async _computeProductPrice() {
            for (const product of this) {
                let pricelist;
                if (product.env.context['pricelist']) {
                    pricelist = this.env.items('product.pricelist').browse(product.env.context['pricelist']);
                }
                else {
                    pricelist = this.env.items('product.pricelist').getDefaultPricelist();
                }
                await product.set('price', (await pricelist.getProductsPrice(product)).get(product.id, 0.0));
            }
        }

    All dependencies must be hashable.  The following keys have special
    support:

    * `company` (value in context or current company id),
    * `uid` (current user id and superuser flag),
    * `activeTest` (value in env.context or value in field.context).
 * @param args 
 * @returns 
 */
export function dependsContext(...args: any[]) {
  return function (target: any, propertyKey?: string) {
    setattr(target[propertyKey], '_dependsContext', args);
  };
}

export function onchange(...args: any[]) {
  return function (target: any, propertyKey: string) {
    setattr(target[propertyKey], '_onchange', args);
  };
}

export function ondelete(atUninstall: any) {
  return function (target: any, propertyKey: string) {
    setattr(target[propertyKey], '_ondelete', atUninstall);
  };
}

export function model() {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    if (propertyKey === 'create') {
      const originalFunc = descriptor.value;
      const wrapper = async function (args: any) {
        return _modelCreateSingle(originalFunc, this, args);
      }
      setattr(wrapper, 'name', originalFunc.name);
      setattr(wrapper, '_api', 'modelCreate');
      descriptor.value = wrapper;
    } else {
      setattr(descriptor.value, '_api', 'model');
    }
  };
}

/**
 * `'create'` expects a dict and returns a record
 * @param create 
 * @param self 
 * @param arg 
 * @returns 
 */
async function _modelCreateSingle(create, self, args) {
  if (!isIterable(args)) {
    return create.call(self, args);
  }
  const list = [];
  for (const vals of args) {
    list.push(await create.call(self, vals));
  }
  return self.browse().concat(list);
}

/**
 *  Decorate a method that takes a dictionary and creates a single record.
    The method may be called with either a single dict or a list of dicts:
      record = await model.create(vals)
      records = await model.create([vals, ...])
 * @param method 
 * @returns 
 */
export function modelCreateMulti() {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalFunc = descriptor.value;
    const wrapper = async function (args: any) {
      return _modelCreateMulti(originalFunc, this, args);
    }
    setattr(wrapper, 'name', originalFunc.name);
    setattr(wrapper, '_api', 'modelCreate');
    descriptor.value = wrapper;
  };
}

async function _modelCreateMulti(create, self, args) {
  if (Array.isArray(args)) {
    if (args.length) {
      return create.call(self, args);
    }
    else {
      return self.browse();
    }
  }
  return create.call(self, [args]);
}

export function decorate(method: Function, caller: Function) {
  return function (...args: any[]) {
    return caller(method, ...args);
  };
}

const WRAPPER_ASSIGNMENTS = ['name'];
const WRAPPER_UPDATES = ['__dict__'];

/**
 * Update a wrapper function to look like the wrapped function
    wrapper is the function to be updated wrapped is the original function assigned is a tuple naming the attributes assigned directly from the wrapped function to the wrapper function (defaults to functools.WRAPPER_ASSIGNMENTS) updated is a tuple naming the attributes of the wrapper that are updated with the corresponding attribute from the wrapped function (defaults to functools.WRAPPER_UPDATES)
 * @param wrapper 
 * @param wrapped 
 * @param assigned 
 * @param updated 
 * @returns 
 */
function updateWrapper(wrapper, wrapped, assigned = WRAPPER_ASSIGNMENTS, updated = WRAPPER_UPDATES) {
  for (const attr of assigned) {
    let value;
    try {
      value = getattr(wrapped, attr);
    } catch (e) {
      if (!isInstance(e, KeyError)) {
        setattr(wrapper, attr, value);
      }
    }
  }
  const attrs = Object.getOwnPropertyNames(wrapped);
  for (const attr of attrs) {
    setattr(wrapper, attr, Object.assign(getattr(wrapper, attr), getattr(wrapped, attr, {})));
  }
  // from the wrapped function when updating __dict__
  wrapper.__wrapped__ = wrapped;
  // Return the wrapper so this can be used as a decorator via partial()
  return wrapper;
}

/**
 * Decorator factory to apply update_wrapper() to a wrapper function
  Returns a decorator that invokes update_wrapper() with the decorated
  function as the wrapper argument and the arguments to wraps() as the
  remaining arguments. Default arguments are as for update_wrapper().
  This is a convenience function to simplify applying partial() to
  update_wrapper().
 * @param wrapped 
 * @param assigned 
 * @param updated 
 * @returns 
 */
export function wraps(wrapper, wrapped: any, assigned = WRAPPER_ASSIGNMENTS, updated = WRAPPER_UPDATES) {
  return partial(updateWrapper, wrapper, wrapped, assigned, updated)
}

export function excludeProperties(propertiesToExclude: string[]) {
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    const originalFunction = descriptor.value; // = target[propertyName];

    descriptor.value = async function (...args: any[]) {
      const originalResult = await originalFunction.apply(this, args);
      propertiesToExclude.forEach(propertyName => {
        delete originalResult[propertyName];
      });
      return originalResult;
    };
  }
}

export function log(constructor: any) {
  console.log(`New ${constructor.name} created!`);
}

/**
 * Decorate a method so that it is called by the daily vacuum cron job (model
    `'ir.autovacuum'`).  This is typically used for garbage-collection-like
    tasks that do not deserve a specific cron job.
 * @param method 
 * @returns 
 */
export function autovacuum() {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    assert(propertyKey.startsWith('_'), f("%s: autovacuum methods must be private", propertyKey));
    setattr(descriptor.value, '_autovacuum', true);
  };
}

/**
 * Decorator for a conditionally applied decorator.
    Example:
      @conditional(getConfig('useCache'), ormcache)
      async fn() {
        // pass
      }
 */
export function conditional(condition, decorator) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    if (condition) {
      descriptor.value = decorator;
    }
  }
}