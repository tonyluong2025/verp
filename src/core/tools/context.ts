import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { setattr } from '../api/func';
import { setOptions } from "./misc";
import { rstringPart, stringPart } from './func';

const _UNSET = new Object();

export class CryptContext {
    schemes: any;
    constructor(schemes, options: { policy?: Object, _autoload?: boolean, deprecated?: any, pbkdf2_sha512__rounds?: number } = {}) {
        this.schemes = schemes;
        setOptions(options, { policy: _UNSET, _autoload: true });
    }

    hash(password: string): string {
        const time = Date.now(); 
        const salt = randomBytes(16);
        const key = scryptSync(password, salt, 64);
        return `${time}$${key.toString("hex")}.${salt.toString("hex")}`;
    }
        
    /**
     * verify password and re-hash the password if needed, all in a single call.
     * @param password 
     * @param hashed 
     * @returns 
     */
    verifyAndUpdate(password: any, hashed: any): [any, any] {
        if (hashed == null) {
            // convenience feature -- let apps pass in hash=null when user
            // isn't found / has no hash; useful because it invokes dummyVerify()
            this.dummyVerify();
            return [false, null];
        }
        if (!this.verify(password, hashed)) {
            return [false, null];
        }
        return [true, this.hash(password)];
    }

    /**
     * verify secret against an existing hash.
     * @param password 
     * @param storedPassword 
     * @returns 
     */
    verify(password: string, storedPassword: string): boolean {
        [, , storedPassword] = rstringPart(storedPassword, '$');
        const [key, , salt] = stringPart(storedPassword, ".");
        if (!salt) {
            return password === key;
        }
        // we need to pass buffer values to timingSafeEqual
        const savedPasswordBuf = Buffer.from(key, "hex");
        const savedSaltBuf = Buffer.from(salt, "hex");
        // we hash the new sign-in password
        const passwordBuf = scryptSync(password, savedSaltBuf, 64);
        // compare the new supplied password with the stored hashed password
        return timingSafeEqual(passwordBuf, savedPasswordBuf);
    }

    
    /**
     * Helper that applications can call when user wasn't found,
          in order to simulate time it would take to hash a password.
          Runs verify() against a dummy hash, to simulate verification
          of a real account password.
     * @param elapsed 
     * @returns 
     */
    dummyVerify() {
        this.verify(this._dummySecret, this._dummyHash);
        return false;
    }

    // secret used for dummyVerify()
    _dummySecret = "too many secrets";

    get _dummyHash() {
        return this.hash(this._dummySecret);
    }
}

class GeneratorContextManager extends Function {
    private func: any;
    private args: any[];

    constructor(func, ...args) {
        super();
        this.func = func;
        this.args = args;
        return new Proxy(this, {
            apply(target, thisArg, args) {
                return func.apply(target, args);
            },
        });
    }
}

export function contextmanager(): any {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const originalFunc = descriptor.value;
        function helper(...args) {
            return new GeneratorContextManager(originalFunc, ...args);
        }
        setattr(helper, 'name', originalFunc.name);
        setattr(helper, 'originalFunc', originalFunc, { enumerable: false });
        descriptor.value = helper;
        return helper;
    }
}