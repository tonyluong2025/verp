import { AbstractModel } from "../../../core/models"
import { MetaModel } from "../../../core/models"
import { decode } from "../../../core/tools/iri";

@MetaModel.define()
class ScssEditor extends AbstractModel {
    static _module = module;
    static _parents = 'webeditor.assets';

    // ----------------------------------------------------------
    // Helper
    // ----------------------------------------------------------

    _getVariable(content: string, variable) {
        const regex = new RegExp(`${variable}\\:?\\s(.*?);`, 'gm');
        const value = content.matchAll(regex).next().value;
        return value && value[1];
    }

    _getVariables(content: string, variables: string[]) {
        return Object.fromEntries(variables.map(variable => [variable, this._getVariable(content, variable)]));
    }

    _replaceVariables(content: string, variables: string[]) {
        for (const variable of variables) {
            const variableContent = `${variable['label']}: ${variable['value']};`;
            const regex = new RegExp(`${variable['label']}\\:?\\s(.*?);`, 'gm');
            content = content.replace(regex, variableContent);
        }
        return content;
    }

    // ----------------------------------------------------------
    // Functions
    // ----------------------------------------------------------

    async getVariablesValues(url, bundle, variables) {
        const self = this as any;
        const customUrl = self.makeCustomAssetFileUrl(url, bundle);
        let content = await self.getAssetContent(customUrl);
        if (! content) {
            content = await self.getAssetContent(url);
        }
        return self._getVariables(content.toString('utf-8'), variables);
    }

    async replaceVariablesValues(url, bundle, variables) {
        const self = this as any;
        const original = (await self.getAssetContent(url)).toString('utf-8');
        const content = self._replaceVariables(original, variables);
        await self.saveAsset(url, bundle, content, 'scss');
    }
}
