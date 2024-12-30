import { MetaModel, Model, _super } from "../../../core/models";
import { _f, bool, quoteList } from "../../../core/tools";

@MetaModel.define()
class IrTranslation extends Model {
  static _module = module;
  static _parents = "ir.translation";

  /**
   * Add missing website specific translation
   * @param modules 
   * @param langs 
   * @param overwrite 
   * @returns 
   */
  async _loadModuleTerms(modules, langs, overwrite: boolean = false) {
    const res = await _super(IrTranslation, this)._loadModuleTerms(modules, langs, overwrite);

    if (!bool(langs) || !bool(modules)) {
      return res;
    }

    let conflictClause;
    if (overwrite) {
      conflictClause = `
                   ON CONFLICT {fields}
                   DO UPDATE SET (label, lang, "resId", src, type, value, module, state, comments) =
                       (EXCLUDED.name, EXCLUDED.lang, EXCLUDED."resId", EXCLUDED.src, EXCLUDED.type,
                        EXCLUDED.value, EXCLUDED.module, EXCLUDED.state, EXCLUDED.comments)
                WHERE EXCLUDED.value IS NOT NULL AND EXCLUDED.value != ''
            `;
    }
    else {
      conflictClause = " ON CONFLICT DO NOTHING";
    }

    // Add specific view translations
    await this.env.cr.execute(`
            INSERT INTO "irTranslation"(label, lang, "resId", src, type, value, module, state, comments)
            SELECT DISTINCT ON (specific.id, t.lang, md5(src)) t.label, t.lang, specific.id, t.src, t.type, t.value, t.module, t.state, t.comments
              FROM "irTranslation" t
             INNER JOIN "irUiView" generic
                ON t.type = 'modelTerms' AND t.label = 'ir.ui.view,archDb' AND t."resId" = generic.id
             INNER JOIN "irUiView" specific
                ON generic.key = specific.key
             WHERE t.lang IN (%s) and t.module IN (%s)
               AND generic."websiteId" IS NULL AND generic.type = 'qweb'
               AND specific."websiteId" IS NOT NULL` + _f(conflictClause, { fields: '(type, label, lang, "resId", md5(src))' }),
      [quoteList(langs), quoteList(modules)]
    );

    const defaultMenu = await this.env.ref('website.mainMenu', false);
    if (!bool(defaultMenu)) {
      return res;
    }

    // Add specific menu translations
    await this.env.cr.execute(`
            INSERT INTO "irTranslation"(label, lang, "resId", src, type, value, module, state, comments)
            SELECT DISTINCT ON (s_menu.id, t.lang) t.label, t.lang, s_menu.id, t.src, t.type, t.value, t.module, t.state, t.comments
              FROM "irTranslation" t
             INNER JOIN "websiteMenu" o_menu
                ON t.type = 'model' AND t.label = 'website.menu,label' AND t."resId" = o_menu.id
             INNER JOIN "websiteMenu" s_menu
                ON o_menu.label = s_menu.label AND o_menu.url = s_menu.url
             INNER JOIN "websiteMenu" root_menu
                ON s_menu."parentId" = root_menu.id AND root_menu."parentId" IS NULL
             WHERE t.lang IN (%s) and t.module IN (%s)
               AND o_menu."websiteId" IS NULL AND o_menu."parentId" = %s
               AND s_menu."websiteId" IS NOT NULL` + _f(conflictClause, { fields: `(type, lang, label, "resId") WHERE type = 'model'` })
      , [quoteList(langs), quoteList(modules), defaultMenu.id])

    return res;
  }
}