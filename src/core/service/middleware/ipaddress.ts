import { format } from "node:util";
import { FrozenSet, NotImplementedError, ValueError } from "../../helper";
import { isInstance } from "../../tools";

const IPV4LENGTH = 32
const IPV6LENGTH = 128

export class AddressValueError extends ValueError {}

export class NetmaskValueError extends ValueError {}

/**
 * Take an IP string/int and return an object of the correct type.

 * @param address A string or integer, the IP address.  Either IPv4 or
          IPv6 addresses may be supplied; integers less than 2**32 will
          be considered to be IPv4 by default
 * @returns An IPv4Address or IPv6Address object
 * @throws ValueError if the *address* passed isn't either a v4 or a v6
          address
 */
export function ipAddress(address) {
  try {
    return new IPv4Address(address);
  } catch(e) {
    if (!isInstance(e, AddressValueError, NetmaskValueError)) {
      throw e;
    }
  }

  try {
    return new IPv6Address(address);
  } catch(e) {
    if (!isInstance(e, AddressValueError, NetmaskValueError)) {
      throw e;
    }
  }

  throw new ValueError('%s does not appear to be an IPv4 or IPv6 address', address);
}

export function ipNetwork(address, strict=true) {}

export function ipInterface(address) {}

export function v4IntToPacked(address) {}

export function v6IntToPacked(address) {}

export function _splitOptionalNetmask(address) {}

export function _findAddressRange(address) {}

export function _countRighthandZeroBits(num, bits) {}

export function summarizeAddressRange(first, last) {}

export function _collapseAddressesInternal(addresses) {}

export function collapseAddresses(addresses) {}

export function getMixedTypeKey(obj) {}

class _IPAddressBase {
  get version() {
    const msg = format('%s has no version specified', typeof(this));
    throw new NotImplementedError(msg);
  }

  _checkIntAddress(address) {
    const self: any = this;
    if (address < 0) {
      const msg = "%s (< 0) is not permitted as an IPv%s address";
      throw new AddressValueError(msg, address, self._version);
    }
    if (address > self._ALL_ONES) {
      const msg = "%s (>= 2**%s) is not permitted as an IPv%s address";
      throw new AddressValueError(msg, address, self._maxPrefixlen, self._version);
    }
  }
}

class _BaseNetwork extends _IPAddressBase {}

class _BaseV4 extends _BaseNetwork {
  _version = 4;
  // Equivalent to 255.255.255.255 or 32 bits of 1's.
  _ALL_ONES = (2**IPV4LENGTH) - 1
  _DECIMAL_DIGITS = new FrozenSet('0123456789');

  // the valid octets for host and netmasks. only useful for IPv4.
  _validMaskOctets = new FrozenSet([255, 254, 252, 248, 240, 224, 192, 128, 0]);

  _maxPrefixlen = IPV4LENGTH;
  // There are only a handful of valid v4 netmasks, so we cache them all
  // when constructed (see _makeNetmask()).
  _netmaskCache = {};
}

class IPv4Address extends _BaseV4 {
  static _constants;
  private _ip: number;

  constructor(address) {
    super();
    if (typeof(address) === 'number') {
      this._checkIntAddress(address);
      this._ip = address;
      return;
    }
  }

  get _constants() {
    return IPv4Address._constants;
  }

  /**
   * Test if this address is allocated for private networks.
      Returns: A boolean, true if the address is reserved per
          iana-ipv4-special-registry.
   */
  // @lruCache()
  get isPrivate() {
    return this._constants._privateNetworks.some(net => net.includes(this));
  }
}

class IPv4Interface extends IPv4Address {
  
}

class IPv4Network extends _BaseV4 {
  constructor(address, strict=true) {
    super();
  }
}

class _IPv4Constants {
  _linklocalNetwork = new IPv4Network('169.254.0.0/16');

  _loopbackNetwork = new IPv4Network('127.0.0.0/8');

  _multicastNetwork = new IPv4Network('224.0.0.0/4');

  _publicNetwork = new IPv4Network('100.64.0.0/10');

  _privateNetworks = [
    new IPv4Network('0.0.0.0/8'),
    new IPv4Network('10.0.0.0/8'),
    new IPv4Network('127.0.0.0/8'),
    new IPv4Network('169.254.0.0/16'),
    new IPv4Network('172.16.0.0/12'),
    new IPv4Network('192.0.0.0/29'),
    new IPv4Network('192.0.0.170/31'),
    new IPv4Network('192.0.2.0/24'),
    new IPv4Network('192.168.0.0/16'),
    new IPv4Network('198.18.0.0/15'),
    new IPv4Network('198.51.100.0/24'),
    new IPv4Network('203.0.113.0/24'),
    new IPv4Network('240.0.0.0/4'),
    new IPv4Network('255.255.255.255/32'),
  ]

  _reservedNetwork = new IPv4Network('240.0.0.0/4');

  _unspecifiedAddress = new IPv4Address('0.0.0.0');
}

IPv4Address._constants = _IPv4Constants;

class _BaseV6 extends _BaseNetwork {}

class IPv6Address extends _BaseV6 {
  static _constants;
  private _ip: number;

  constructor(address) {
    super();
    if (typeof(address) === 'number') {
      this._checkIntAddress(address);
      this._ip = address;
      return;
    }
  }

  get _constants() {
    return IPv6Address._constants;
  }

  get isPrivate() {
    return this._constants._privateNetworks.some(net => net.includes(this));
  }
}

class _IPv6Constants {}

IPv6Address._constants = _IPv6Constants;