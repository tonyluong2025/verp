import { tools } from ".."
import * as core from "..";
import { Environment } from "../api";
import { ValueError } from "../helper";
import { doWith, len } from "../tools";
import { fnmatch } from "../tools/fnmatch";
import { Command } from "./command"

class Populate extends Command {
    async run(args: string[]) {
        const parser = tools.config.parser;
        const argConfig = {
            group: "Populate Configuration",
            definitions: [
                {name: "size", defaultValue: 'small', destination: "populationSize",
                    description: "Populate database with auto-generated data. Value should be the population size: small, medium or large",},
                {name: "models", destination: 'populateModels', description: "Comma separated list of model or pattern (fnmatch)"}
            ]
        }
        let opt = parser.parseArgs(argConfig.definitions, { argv: args, camelCase: true, stopAtFirstUnknown: false, partial: true });
        const populateModels = opt.models && new Set(opt.populateModels.split(','));
        const populationSize = opt.size;
        const dbName = tools.config.get('dbName');
        const registry = await core.registry(dbName);
        const cr = registry.cursor();
        await doWith(cr, async () => {
            const env = await core.api.Environment.new(cr, global.SUPERUSER_ID);
            await this.populate(env, populationSize, populateModels);
        });
    }

    async populate(env: Environment, size: string, modelPatterns: any=false) {
        const registry = env.registry;
        let populatedModels;
        try {
            registry.populatedModels = {};  // todo master, initialize with already populated models
            const orderedModels = await this._getOrderedModels(env, modelPatterns);

            console.log(25, 'Populating database');
            for (const model of orderedModels) {
                console.info('Populating database for model %s', model._name);
                const t0 = new Date();
                registry.populatedModels[model._name] = (await model._populate(size)).ids;
                // todo indicate somewhere that model is populated
                await env.cr.commit();
                const modelTime = new Date().getMilliseconds() - t0.getMilliseconds();
                if (modelTime > 1) {
                    console.info('Populated database for model %s (total: %s) (average: %s ms per record)',
                                 model._name, modelTime, modelTime / len(registry.populatedModels[model._name]) * 1000);
                }
            }
        } catch(e) {
            console.error('Something went wrong populating database');
        } finally {
            populatedModels = registry.populatedModels;
            registry.populatedModels = null;
        }

        return populatedModels;
    }

    async _getOrderedModels(env, modelPatterns?: []) {
        console.info('Computing model order');
        const processed = new Set<string>();
        const orderedModels = [];
        const visited = new Set<string>();
        
        function addModel(model) {
            if (!processed.has(model)) {
                if (visited.has(model)) {
                    throw new ValueError('Cyclic dependency detected for %s', model);
                }
                visited.add(model);
                for (const dep of model._populateDependencies) {
                    addModel(env.models[dep]);
                }
                orderedModels.push(model);
                processed.add(model);
            }
        }
        for (const model of env.models.values()) {
            const irModel = await env.items('ir.model').search([['model', '=', model._name]]);
            if (modelPatterns && !modelPatterns.some(pattern => fnmatch(model._name, pattern))) {
                continue;
            }
            if (model._transient || model._abstract) {
                continue;
            }
            if (! modelPatterns && (await irModel.modules).split(',').every(mod => mod.startsWith('test_'))) {
                continue;
            }
            addModel(model);
        }
        return orderedModels;
    }
}

export const populate = new Populate();