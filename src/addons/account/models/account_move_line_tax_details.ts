import { api } from "../../../core";
import { MetaModel, Model } from "../../../core/models";
import { Query } from "../../../core/osv";
import { quoteDouble, quoteList } from "../../../core/tools";
import { extend } from "../../../core/tools/iterable";
import { f } from "../../../core/tools/utils";

@MetaModel.define()
class AccountMoveLine extends Model {
    static _module = module;
    static _parents = 'account.move.line';

    /**
     * Create the tax details sub-query based on the orm domain passed as parameter.
  
        :param domain:      An orm domain on account.move.line.
        :param fallback:    Fallback on an approximated mapping if the mapping failed.
        :return:            A tuple <query, params>.
     * @param domain 
     * @param fallback 
     * @returns 
     */
    @api.model()
    async _getQueryTaxDetailsFromDomain(domain, fallback = true) {
        await this.env.items('account.move.line').checkAccessRights('read');

        const query: Query = await this.env.items('account.move.line')._whereCalc(domain);

        // Wrap the query with 'companyId IN (...)' to avoid bypassing company access rights.
        await this.env.items('account.move.line')._applyIrRules(query);

        const [tables, whereClause, whereParams] = query.getSql();
        return this._getQueryTaxDetails(tables, whereClause, whereParams, fallback);
    }

    /**
     * Create the tax details sub-query based on the orm domain passed as parameter.
  
        :param tables:          The 'tables' query to inject after the FROM.
        :param where_clause:    The 'where_clause' query computed based on an orm domain.
        :param where_params:    The params to fill the 'where_clause' query.
        :param fallback:        Fallback on an approximated mapping if the mapping failed.
        :return:                A tuple <query, params>.
     * @param tables 
     * @param whereClause 
     * @param whereParams 
     * @param fallback 
     */
    @api.model()
    async _getQueryTaxDetails(tables, whereClause, whereParams, fallback = true) {
        const groupTaxes = await this.env.items('account.tax').search([['amountType', '=', 'group']]);

        const groupTaxesQueryList = [];
        const groupTaxesParams = [];
        for (const groupTax of groupTaxes) {
            const childrenTaxes = await groupTax.childrenTaxIds;
            if (!childrenTaxes.ok) {
                continue;
            }

            const childrenTaxesInQuery = Array.from(await childrenTaxes.map(() => '%s')).join(',');
            groupTaxesQueryList.push(`WHEN tax.id = %s THEN ARRAY[${childrenTaxesInQuery}]`);
            groupTaxesParams.push(groupTax.id);
            extend(groupTaxesParams, childrenTaxes.ids);
        }
        let groupTaxesQuery;
        if (groupTaxesQueryList.length) {
            groupTaxesQuery = `UNNEST(CASE ${groupTaxesQueryList.join(' ')} ELSE ARRAY[tax.id] END)`;
        }
        else {
            groupTaxesQuery = 'tax.id';
        }

        tables = quoteList(tables, quoteDouble);
        let fallbackQuery, fallbackParams;
        if (fallback) {
            fallbackQuery = `
                UNION ALL

                SELECT
                    "accountMoveLine".id AS "taxLineId",
                    "baseLine".id AS "baseLineId",
                    "baseLine".id AS "srcLineId",
                    "baseLine".balance AS "baseAmount",
                    "baseLine"."amountCurrency" AS "baseAmountCurrency"
                FROM ${tables}
                LEFT JOIN "baseTaxLineMapping" ON
                    "baseTaxLineMapping"."taxLineId" = accountMoveLine.id
                JOIN "accountMoveLineAccountTaxRel" "taxRel" ON
                    "taxRel"."accountTaxId" = COALESCE(accountMoveLine."groupTaxId", accountMoveLine."taxLineId")
                JOIN "accountMoveLine" "baseLine" ON
                    "baseLine".id = "taxRel"."accountMoveLineId"
                    AND "baseLine"."taxRepartitionLineId" IS NULL
                    AND "baseLine"."moveId" = "accountMoveLine"."moveId"
                    AND "baseLine"."currencyId" = "accountMoveLine"."currencyId"
                WHERE "baseTaxLineMapping"."taxLineId" IS NULL
                AND ${whereClause}
            `;
            fallbackParams = whereParams;
        }
        else {
            fallbackQuery = '';
            fallbackParams = [];
        }

        return f(`
            /
            As example to explain the different parts of the query, we'll consider a move with the following lines:
            label            TaxLineId         TaxIds                 Debit       Credit      Base lines
            ---------------------------------------------------------------------------------------------------
            baseLine_1                         10_affectBase, 20      1000
            baseLine_2                         10_affectBase, 5       2000
            baseLine_3                         10_affectBase, 5       3000
            taxLine_1      10_affectBase       20                                 100         baseLine_1
            taxLine_2      20                                                     220         baseLine_1
            taxLine_3      10_affectBase       5                                  500         baseLine_2/3
            taxLine_4      5                                                      275         baseLine_2/3
            /

            WITH "affectingBaseTaxIds" AS (

                /
                This CTE builds a reference table based on the taxIds field, with the following changes:
                  - flatten the group of taxes
                  - exclude the taxes having 'isBaseAffected' set to false.
                Those allow to match only baseLine_1 when finding the base lines of taxLine_1, as we need to find
                base lines having a 'affectingBaseTaxIds' ending with [10_affectBase, 20], not only containing
                '10_affectBase'. Otherwise, baseLine_2/3 would also be matched.
                In our example, as all the taxes are set to be affected by previous ones affecting the base, the
                result is similar to the table 'accountMoveLineAccountTaxRel':
                Id                 TaxIds
                -------------------------------------------
                baseLine_1        [10_affectBase, 20]
                baseLine_2        [10_affectBase, 5]
                baseLine_3        [10_affectBase, 5]
                /

                SELECT
                    sub."lineId" AS id,
                    ARRAY_AGG(sub."taxId" ORDER BY sub.sequence, sub."taxId") AS "taxIds"
                FROM (
                    SELECT
                        "taxRel"."accountMoveLineId" AS "lineId",
                        ${groupTaxesQuery} AS "taxId",
                        tax.sequence
                    FROM ${tables}
                    JOIN "accountMoveLineAccountTaxRel" "taxRel" ON accountMoveLine.id = "taxRel"."accountMoveLineId"
                    JOIN "accountTax" tax ON tax.id = "taxRel"."accountTaxId"
                    WHERE tax."isBaseAffected"
                    AND ${whereClause}
                ) AS sub
                GROUP BY sub."lineId"
            ),

            "baseTaxLineMapping" AS (

                /
                Create the mapping of each tax lines with their corresponding base lines.

                In the example, it will give the following values:
                    baseLineId     taxLineId    baseAmount
                    -------------------------------------------
                    baseLine_1      taxLine_1         1000
                    baseLine_1      taxLine_2         1000
                    baseLine_2      taxLine_3         2000
                    baseLine_2      taxLine_4         2000
                    baseLine_3      taxLine_3         3000
                    baseLine_3      taxLine_4         3000
                /

                SELECT
                    "accountMoveLine".id AS "taxLineId",
                    "baseLine".id AS "baseLineId",
                    "baseLine".balance AS "baseAmount",
                    "baseLine"."amountCurrency" AS "baseAmountCurrency"

                FROM ${tables}
                JOIN "accountTaxRepartitionLine" "taxRep" ON
                    "taxRep".id = "accountMoveLine"."taxRepartitionLineId"
                JOIN "accountTax" tax ON
                    tax.id = "accountMoveLine"."taxLineId"
                JOIN "resCurrency" curr ON
                    curr.id = "accountMoveLine"."currencyId"
                JOIN "resCurrency" "compCurr" ON
                    "compCurr".id = "accountMoveLine"."companyCurrencyId"
                JOIN "accountMoveLineAccountTaxRel" "taxRel" ON
                    "taxRel"."accountTaxId" = COALESCE("accountMoveLine"."groupTaxId", "accountMoveLine"."taxLineId")
                JOIN "accountMoveLine" "baseLine" ON
                    "baseLine".id = "taxRel"."accountMoveLineId"
                    AND "baseLine"."taxRepartitionLineId" IS NULL
                    AND "baseLine"."moveId" = "accountMoveLine"."moveId"
                    AND COALESCE("baseLine"."partnerId", 0) = COALESCE("accountMoveLine"."partnerId", 0)
                    AND "baseLine"."currencyId" = "accountMoveLine"."currencyId"
                    AND (
                        COALESCE("taxRep"."accountId", "baseLine"."accountId") = "accountMoveLine"."accountId"
                        OR (tax."taxExigibility" = 'onPayment' AND tax."cashBasisTransitionAccountId" IS NOT NULL)
                    )
                    AND (
                        NOT tax.analytic
                        OR ("baseLine"."analyticAccountId" IS NULL AND "accountMoveLine"."analyticAccountId" IS NULL)
                        OR "baseLine"."analyticAccountId" = "accountMoveLine"."analyticAccountId"
                    )
                LEFT JOIN "affectingBaseTaxIds" "taxLineTaxIds" ON "taxLineTaxIds".id = "accountMoveLine".id
                JOIN "affectingBaseTaxIds" "baseLineTaxIds" ON "baseLineTaxIds".id = "baseLine".id
                WHERE "accountMoveLine"."taxRepartitionLineId" IS NOT NULL
                    AND ${whereClause}
                    AND (
                        -- keeping only the rows from affectingBaseTaxLines that end with the same taxes applied (see comment in affectingBaseTaxIds)
                        NOT tax."includeBaseAmount"
                        OR "baseLineTaxIds"."taxIds"[ARRAY_LENGTH("baseLineTaxIds"."taxIds", 1) - COALESCE(ARRAY_LENGTH("taxLineTaxIds"."taxIds", 1), 0):ARRAY_LENGTH("baseLineTaxIds"."taxIds", 1)]
                            = ARRAY["accountMoveLine"."taxLineId"] || COALESCE("taxLineTaxIds"."taxIds", ARRAY[]::INTEGER[])
                    )
            ),


            "taxAmountAffectingBaseToDispatch" AS (

                //
                Computes the total amount to dispatch in case of tax lines affecting the base of subsequent taxes.
                Such tax lines are an additional base amount for others lines, that will be truly dispatch in next
                CTE.

                In the example:
                    - taxLine_1 is an additional base of 100.0 from baseLine_1 for taxLine_2.
                    - taxLine_3 is an additional base of 2/5 * 500.0 = 200.0 from baseLine_2 for taxLine_4.
                    - taxLine_3 is an additional base of 3/5 * 500.0 = 300.0 from baseLine_3 for taxLine_4.

                    srcLineId    baseLineId     taxLineId    totalBaseAmount
                    -------------------------------------------------------------
                    taxLine_1    baseLine_1     taxLine_2         1000
                    taxLine_3    baseLine_2     taxLine_4         5000
                    taxLine_3    baseLine_3     taxLine_4         5000
                //

                SELECT
                    "taxLine".id AS "taxLineId",
                    "baseLine".id AS "baseLineId",
                    "accountMoveLine".id AS "srcLineId",

                    "taxLine"."companyId",
                    "compCurr".id AS "companyCurrencyId",
                    "compCurr"."decimalPlaces" AS "compCurrPrec",
                    curr.id AS "currencyId",
                    curr."decimalPlaces" AS "currPrec",

                    "taxLine"."taxLineId" AS "taxId",

                    "baseLine".balance AS "baseAmount",
                    SUM(
                        CASE WHEN tax."amountType" = 'fixed'
                        THEN CASE WHEN "baseLine".balance < 0 THEN -1 ELSE 1 END * ABS(COALESCE("baseLine".quantity, 1.0))
                        ELSE "baseLine".balance
                        END
                    ) OVER (PARTITION BY "taxLine".id, "accountMoveLine".id ORDER BY "taxLine"."taxLineId", "baseLine".id) AS "cumulatedBaseAmount",
                    SUM(
                        CASE WHEN tax."amountType" = 'fixed'
                        THEN CASE WHEN "baseLine".balance < 0 THEN -1 ELSE 1 END * ABS(COALESCE("baseLine".quantity, 1.0))
                        ELSE "baseLine".balance
                        END
                    ) OVER (PARTITION BY "taxLine".id, "accountMoveLine".id) AS "totalBaseAmount",
                    "accountMoveLine".balance AS "totalTaxAmount",

                    "baseLine"."amountCurrency" AS "baseAmountCurrency",
                    SUM(
                        CASE WHEN tax."amountType" = 'fixed'
                        THEN CASE WHEN "baseLine"."amountCurrency" < 0 THEN -1 ELSE 1 END * ABS(COALESCE("baseLine".quantity, 1.0))
                        ELSE "baseLine"."amountCurrency"
                        END
                    ) OVER (PARTITION BY "taxLine".id, "accountMoveLine".id ORDER BY "taxLine"."taxLineId", "baseLine".id) AS "cumulatedBaseAmountCurrency",
                    SUM(
                        CASE WHEN tax."amountType" = 'fixed'
                        THEN CASE WHEN "baseLine"."amountCurrency" < 0 THEN -1 ELSE 1 END * ABS(COALESCE("baseLine".quantity, 1.0))
                        ELSE "baseLine"."amountCurrency"
                        END
                    ) OVER (PARTITION BY "taxLine".id, "accountMoveLine".id) AS "totalBaseAmountCurrency",
                    "accountMoveLine"."amountCurrency" AS "totalTaxAmountCurrency"

                FROM ${tables}
                JOIN "accountTax" "taxIncludeBaseAmount" ON
                    "taxIncludeBaseAmount"."includeBaseAmount"
                    AND "taxIncludeBaseAmount".id = "accountMoveLine"."taxLineId"
                JOIN "baseTaxLineMapping" "baseTaxLineMapping" ON
                    "baseTaxLineMapping"."taxLineId" = "accountMoveLine".id
                JOIN "accountMoveLineAccountTaxRel" "taxRel" ON
                    "taxRel"."accountMoveLineId" = "baseTaxLineMapping"."taxLineId"
                JOIN "accountTax" tax ON
                    tax.id = "taxRel"."accountTaxId"
                JOIN "baseTaxLineMapping" "taxLineMatching" ON
                    "taxLineMatching".'baseLineId' = "baseTaxLineMapping"."baseLineId"
                JOIN "accountMoveLine" "taxLine" ON
                    "taxLine".id = "taxLineMatching"."taxLineId"
                    AND "taxLine"."taxLineId" = "taxRel"."accountTaxId"
                JOIN "resCurrency" curr ON
                    curr.id = "taxLine"."currencyId"
                JOIN "resCurrency" "compCurr" ON
                    "compCurr".id = "taxLine"."companyCurrencyId"
                JOIN "accountMoveLine" "baseLine" ON
                    "baseLine".id = "baseTaxLineMapping"."baseLineId"
                WHERE ${whereClause}
            ),


            baseTaxMatchingBaseAmounts AS (

                /
                Build here the full mapping tax lines <=> base lines containing the final base amounts.
                This is done in a 3-parts union.

                Note: srcLineId is used only to build a unique ID.
                /

                /
                PART 1: raw mapping computed in baseTaxLineMapping.
                /

                SELECT
                    "taxLineId",
                    "baseLineId",
                    "baseLineId" AS "srcLineId",
                    "baseAmount",
                    "baseAmountCurrency"
                FROM "baseTaxLineMapping"

                UNION ALL

                /
                PART 2: Dispatch the tax amount of tax lines affecting the base of subsequent ones, using
                "taxAmountAffectingBaseToDispatch".

                This will effectively add the following rows:
                baseLineId    taxLineId     srcLineId     baseAmount
                -------------------------------------------------------------
                baseLine_1    taxLine_2     taxLine_1      100
                baseLine_2    taxLine_4     taxLine_3      200
                baseLine_3    taxLine_4     taxLine_3      300
                /

                SELECT
                    sub."taxLineId",
                    sub."baseLineId",
                    sub."srcLineId",

                    ROUND(
                        COALESCE(sub."totalTaxAmount" * ABS(sub."cumulatedBaseAmount") / ABS(NULLIF(sub."totalBaseAmount", 0.0)), 0.0),
                        sub."compCurrPrec"
                    )
                    - LAG(ROUND(
                        COALESCE(sub."totalTaxAmount" * ABS(sub."cumulatedBaseAmount") / ABS(NULLIF(sub."totalBaseAmount", 0.0)), 0.0),
                        sub."compCurrPrec"
                    ), 1, 0.0)
                    OVER (
                        PARTITION BY sub.taxLineId, sub."srcLineId" ORDER BY sub."taxId", sub."baseLineId"
                    ) AS "baseAmount",

                    ROUND(
                        COALESCE(sub."totalTaxAmountCurrency" * ABS(sub."cumulatedBaseAmountCurrency") / ABS(NULLIF(sub."totalBaseAmountCurrency", 0.0)), 0.0),
                        sub."currPrec"
                    )
                    - LAG(ROUND(
                        COALESCE(sub."totalTaxAmountCurrency" * ABS(sub."cumulatedBaseAmountCurrency") / ABS(NULLIF(sub."totalBaseAmountCurrency", 0.0)), 0.0),
                        sub."currPrec"
                    ), 1, 0.0)
                    OVER (
                        PARTITION BY sub."taxLineId", sub."srcLineId" ORDER BY sub."taxId", sub."baseLineId"
                    ) AS "baseAmountCurrency"
                FROM "taxAmountAffectingBaseToDispatch" sub
                JOIN "accountMoveLine" "taxLine" ON
                    "taxLine".id = sub."taxLineId"

                /
                PART 3: In case of the matching failed because the configuration changed or some journal entries
                have been imported, construct a simple mapping as a fallback. This mapping is super naive and only
                build based on the 'taxIds' and 'taxLineId' fields, nothing else. Hence, the mapping will not be
                exact but will give an acceptable approximation.

                Skipped if the 'fallback' method parameter is false.
                /
                ${fallbackQuery}
            ),


            "baseTaxMatchingAllAmounts" AS (

                /
                Complete baseTaxMatchingBaseAmounts with the tax amounts (prorata):
                baseLineId     taxLineId       srcLineId       baseAmount      taxAmount
                --------------------------------------------------------------------------
                baseLine_1     taxLine_1       baseLine_1     1000            100
                baseLine_1     taxLine_2       baseLine_1     1000            (1000 / 1100) * 220 = 200
                baseLine_1     taxLine_2       taxLine_1      100             (100 / 1100) * 220 = 20
                baseLine_2     taxLine_3       baseLine_2     2000            (2000 / 5000) * 500 = 200
                baseLine_2     taxLine_4       baseLine_2     2000            (2000 / 5500) * 275 = 100
                baseLine_2     taxLine_4       taxLine_3      200             (200 / 5500) * 275 = 10
                baseLine_3     taxLine_3       baseLine_3     3000            (3000 / 5000) * 500 = 300
                baseLine_3     taxLine_4       baseLine_3     3000            (3000 / 5500) * 275 = 150
                baseLine_3     taxLine_4       taxLine_3      300             (300 / 5500) * 275 = 15
                /

                SELECT
                    sub."taxLineId",
                    sub."baseLineId",
                    sub."srcLineId",

                    "taxLine"."taxLineId" AS "taxId",
                    "taxLine"."groupTaxId",

                    "taxLine"."companyId",
                    "compCurr".id AS "companyCurrencyId",
                    "compCurr"."decimalPlaces" AS "compCurrPrec",
                    curr.id AS "currencyId",
                    curr."decimalPlaces" AS "currPrec",
                    (
                        tax."taxExigibility" != 'onPayment'
                        OR "taxMove"."taxCashBasisRecId" IS NOT NULL
                        OR "taxMove"."alwaysTaxExigible"
                    ) AS "taxExigible",
                    "baseLine"."accountId" AS "baseAccountId",

                    sub."baseAmount",
                    SUM(
                        CASE WHEN tax."amountType" = 'fixed'
                        THEN CASE WHEN "baseLine".balance < 0 THEN -1 ELSE 1 END * ABS(COALESCE("baseLine".quantity, 1.0))
                        ELSE sub."baseAmount"
                        END
                    ) OVER (PARTITION BY "taxLine".id ORDER BY "taxLine"."taxLineId", sub.'baseLineId', sub."srcLineId") AS "cumulatedBaseAmount",
                    SUM(
                        CASE WHEN tax."amountType" = 'fixed'
                        THEN CASE WHEN "baseLine".balance < 0 THEN -1 ELSE 1 END * ABS(COALESCE("baseLine".quantity, 1.0))
                        ELSE sub."baseAmount"
                        END
                    ) OVER (PARTITION BY "taxLine".id) AS "totalBaseAmount",
                    "taxLine".balance AS "totalTaxAmount",

                    sub."baseAmountCurrency",
                    SUM(
                        CASE WHEN tax."amountType" = 'fixed'
                        THEN CASE WHEN "baseLine"."amountCurrency" < 0 THEN -1 ELSE 1 END * ABS(COALESCE("baseLine".quantity, 1.0))
                        ELSE sub."baseAmountCurrency"
                        END
                    ) OVER (PARTITION BY "taxLine".id ORDER BY "taxLine".'taxLineId', sub."baseLineId", sub."srcLineId") AS "cumulatedBaseAmountCurrency",
                    SUM(
                        CASE WHEN tax."amountType" = 'fixed'
                        THEN CASE WHEN "baseLine".'amountCurrency' < 0 THEN -1 ELSE 1 END * ABS(COALESCE("baseLine".quantity, 1.0))
                        ELSE sub."baseAmountCurrency"
                        END
                    ) OVER (PARTITION BY "taxLine".id) AS "totalBaseAmountCurrency",
                    "taxLine"."amountCurrency" AS "totalTaxAmountCurrency"

                FROM "baseTaxMatchingBaseAmounts" sub
                JOIN "accountMoveLine" "taxLine" ON
                    "taxLine".id = sub."taxLineId"
                JOIN "accountMove" "taxMove" ON
                    "taxMove".id = "taxLine"."moveId"
                JOIN "accountMoveLine" "baseLine" ON
                    "baseLine".id = sub."baseLineId"
                JOIN "accountTax" tax ON
                    tax.id = "taxLine"."taxLineId"
                JOIN "resCurrency" curr ON
                    curr.id = "taxLine"."currencyId"
                JOIN "resCurrency" "compCurr" ON
                    "compCurr".id = "taxLine"."companyCurrencyId"

            )


           / Final select that makes sure to deal with rounding errors, using LAG to dispatch the last cents. /

            SELECT
                sub."taxLineId" || '-' || sub."baseLineId" || '-' || sub."srcLineId" AS id,

                sub."baseLineId",
                sub."taxLineId",
                sub."srcLineId",

                sub."taxId",
                sub."groupTaxId",
                sub."taxExigible",
                sub."baseAccountId",

                sub."baseAmount",
                ROUND(
                    COALESCE(sub."totalTaxAmount" * ABS(sub."cumulatedBaseAmount") / ABS(NULLIF(sub."totalBaseAmount", 0.0)), 0.0),
                    sub."compCurrPrec"
                )
                - LAG(ROUND(
                    COALESCE(sub."totalTaxAmount" * ABS(sub."cumulatedBaseAmount") / ABS(NULLIF(sub."totalBaseAmount", 0.0)), 0.0),
                    sub."compCurrPrec"
                ), 1, 0.0)
                OVER (
                    PARTITION BY sub."taxLineId" ORDER BY sub."taxId", sub."baseLineId"
                ) AS "taxAmount",

                sub."baseAmountCurrency",
                ROUND(
                    COALESCE(sub."totalTaxAmountCurrency" * ABS(sub."cumulatedBaseAmountCurrency") / ABS(NULLIF(sub."totalBaseAmountCurrency", 0.0)), 0.0),
                    sub."currPrec"
                )
                - LAG(ROUND(
                    COALESCE(sub."totalTaxAmountCurrency" * ABS(sub."cumulatedBaseAmountCurrency") / ABS(NULLIF(sub.'totalBaseAmountCurrency', 0.0)), 0.0),
                    sub."currPrec"
                ), 1, 0.0)
                OVER (
                    PARTITION BY sub."taxLineId" ORDER BY sub."taxId", sub."baseLineId"
                ) AS "taxAmountCurrency"
            FROM "baseTaxMatchingAllAmounts" sub
        `, groupTaxesParams.concat(whereParams).concat(whereParams).concat(whereParams).concat(fallbackParams));
    }
}