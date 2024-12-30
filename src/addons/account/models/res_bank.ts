import { api } from "../../../core";
import { AttributeError, UserError, ValueError } from "../../../core/helper/errors";
import { MetaModel, Model } from "../../../core/models";
import { HTTPException } from "../../../core/service/middleware/exceptions";
import { URI, b64encode, imageDataUri, isInstance, pop, sorted } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";

@MetaModel.define()
class ResPartnerBank extends Model {
  static _module = module;
  static _parents = 'res.partner.bank';

  /**
   * Returns the QR-code vals needed to generate the QR-code report link to pay this account with the given parameters,
      or None if no QR-code could be generated.

      :param amount: The amount to be paid
      :param free_communication: Free communication to add to the payment when generating one with the QR-code
      :param structured_communication: Structured communication to add to the payment when generating one with the QR-code
      :param currency: The currency in which amount is expressed
      :param debtor_partner: The partner to which this QR-code is aimed (so the one who will have to pay)
      :param qr_method: The QR generation method to be used to make the QR-code. If None, the first one giving a result will be used.
      :param silent_errors: If true, forbids errors to be raised if some tested QR-code format can't be generated because of incorrect data.
   * @param amount 
   * @param freeCommunication 
   * @param structuredCommunication 
   * @param currency 
   * @param debtorPartner 
   * @param option 
   * @returns 
   */
  async _buildQrCodeVals(amount, freeCommunication, structuredCommunication, currency, debtorPartner, options: { qrMethod?: any, silentErrors?: boolean }) {
    options = options ?? { silentErrors: true };
    const qrMethod = options.qrMethod;
    if (!this.ok) {
      return null;
    }

    this.ensureOne();

    if (!bool(currency)) {
      throw new UserError(await this._t("Currency must always be provided in order to generate a QR-code"));
    }

    const availableQrMethods = await this.getAvailableQrMethodsInSequence();
    const candidateMethods = bool(qrMethod) ? [[qrMethod, Object.assign({}, availableQrMethods)[qrMethod]]] : availableQrMethods;
    for (const [candidateMethod, candidateName] of candidateMethods) {
      if (await this._eligibleForQrCode(candidateMethod, debtorPartner, currency)) {
        const errorMessage = await this._checkForQrCodeErrors(candidateMethod, amount, currency, debtorPartner, freeCommunication, structuredCommunication)

        if (!bool(errorMessage)) {
          return {
            'qrMethod': candidateMethod,
            'amount': amount,
            'currency': currency,
            'debtorPartner': debtorPartner,
            'freeCommunication': freeCommunication,
            'structuredCommunication': structuredCommunication,
          }
        }
        else if (!bool(options.silentErrors)) {
          const errorHeader = await this._t("The following error prevented '%s' QR-code to be generated though it was detected as eligible: ", candidateName);
          throw new UserError(errorHeader + errorMessage);
        }
      }
    }
    return null;
  }

  async buildQrCodeUrl(amount, free_communication, structured_communication, currency, debtor_partner, options: { qrMethod?: any, silentErrors?: boolean }) {
    options = options ?? { silentErrors: true };
    const qrMethod = options.qrMethod;
    const vals = await this._buildQrCodeVals(amount, free_communication, structured_communication, currency, debtor_partner, options);
    if (bool(vals)) {
      return this._getQrCodeUrl(
        vals['qrMethod'],
        vals['amount'],
        vals['currency'],
        vals['debtorPartner'],
        vals['freeCommunication'],
        vals['structuredCommunication'],
      );
    }
    return null;

  }

  async buildQrCodeBase64(amount, freeCommunication, structuredCommunication, currency, debtorPartner, options: { qrMethod?: any, silentErrors?: boolean }) {
    options = options ?? { silentErrors: true };
    const qrMethod = options.qrMethod;
    const vals = await this._buildQrCodeVals(amount, freeCommunication, structuredCommunication, currency, debtorPartner, options);
    if (bool(vals)) {
      return this._getQrCodeBase64(
        vals['qrMethod'],
        vals['amount'],
        vals['currency'],
        vals['debtorPartner'],
        vals['freeCommunication'],
        vals['structuredCommunication']
      );
    }
    return null;
  }

  async _getQrVals(qrMethod, amount, currency, debtorPartner, freeCommunication, structuredCommunication) {
    return null;
  }

  async _getQrCodeGenerationParams(qrMethod, amount, currency, debtorPartner, freeCommunication, structuredCommunication) {
    return null;
  }

  /**
   * Hook for extension, to support the different QR generation methods.
      This function uses the provided qr_method to try generation a QR-code for
      the given data. It it succeeds, it returns the report URL to make this
      QR-code; else None.

      :param qrMethod: The QR generation method to be used to make the QR-code.
      :param amount: The amount to be paid
      :param currency: The currency in which amount is expressed
      :param debtorPartner: The partner to which this QR-code is aimed (so the one who will have to pay)
      :param freeCommunication: Free communication to add to the payment when generating one with the QR-code
      :param structuredCommunication: Structured communication to add to the payment when generating one with the QR-code
   */
  async _getQrCodeUrl(qrMethod, amount, currency, debtorPartner, freeCommunication, structuredCommunication) {
    // pylint: disable=E1137
    // (PyLint doesn't get that we are not assigning to None here)
    const params = await this._getQrCodeGenerationParams(qrMethod, amount, currency, debtorPartner, freeCommunication, structuredCommunication);
    if (bool(params)) {
      params['type'] = pop(params, 'barcodeType');
      const uri = new URI('/report/barcode/?');
      Object.assign(uri, params);
      return uri.toString();
    }
    return null;
  }

  /**
   * Hook for extension, to support the different QR generation methods.
      This function uses the provided qr_method to try generation a QR-code for
      the given data. It it succeeds, it returns QR code in base64 url; else None.

      :param qrMethod: The QR generation method to be used to make the QR-code.
      :param amount: The amount to be paid
      :param currency: The currency in which amount is expressed
      :param debtorPartner: The partner to which this QR-code is aimed (so the one who will have to pay)
      :param freeCommunication: Free communication to add to the payment when generating one with the QR-code
      :param structuredCommunication: Structured communication to add to the payment when generating one with the QR-code
   */
  async _getQrCodeBase64(qrMethod, amount, currency, debtorPartner, freeCommunication, structuredCommunication) {
    const params = await this._getQrCodeGenerationParams(qrMethod, amount, currency, debtorPartner, freeCommunication, structuredCommunication);
    if (bool(params)) {
      let barcode;
      try {
        barcode = this.env.items('ir.actions.report').barcode(...params);
      } catch (e) {
        if (isInstance(e, ValueError, AttributeError)) {
          throw new HTTPException(null, 'Cannot convert into barcode.');
        }
        throw e;
      }
      return imageDataUri(b64encode(barcode));
    }
    return null;
  }

  /**
   * Returns the QR-code generation methods that are available on this db,
      in the form of a list of (code, label, sequence) elements, where
      'code' is a unique string identifier, 'label' the label to display
      to the user to designate the method, and 'sequence' is a positive integer
      indicating the order in which those mehtods need to be checked, to avoid
      shadowing between them (lower sequence means more prioritary).
   * @returns 
   */
  @api.model()
  async _getAvailableQrMethods() {
    return [];
  }

  /**
   * Same as _get_available_qr_methods but without returning the sequence,
      and using it directly to order the returned list.
   * @returns 
   */
  @api.model()
  async getAvailableQrMethodsInSequence() {
    let allAvailable = await this._getAvailableQrMethods();
    allAvailable = sorted(allAvailable, (x) => x[2]);
    return allAvailable.map(([code, name]) => [code, name]);
  }

  /**
   * Tells whether or not the criteria to apply QR-generation
      method qr_method are met for a payment on this account, in the
      given currency, by debtor_partner. This does not impeach generation errors,
      it only checks that this type of QR-code *should be* possible to generate.
      Consistency of the required field needs then to be checked by _check_for_qr_code_errors().
   * @param qrMethod 
   * @param debtorPartner 
   * @param currency 
   * @returns 
   */
  async _eligibleForQrCode(qrMethod, debtorPartner, currency) {
    return false;
  }

  /**
   * Checks the data before generating a QR-code for the specified qr_method
      (this method must have been checked for eligbility by _eligible_for_qr_code() first).

      Returns None if no error was found, or a string describing the first error encountered
      so that it can be reported to the user.
   */
  async _checkForQrCodeErrors(qrMethod, amount, currency, debtorPartner, freeCommunication, structuredCommunication) {
    return null
  }
}