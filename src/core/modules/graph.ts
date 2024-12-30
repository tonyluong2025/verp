import { modules, tools } from "..";
import { setattr } from "../api";
import { Cursor } from "../sql_db";
import { sorted } from "../tools/iterable";
import { quoteList } from "../tools/sql";

type indexType = string|number|symbol|null;

export class Graph {
  [index: indexType]: any;

  get length() {
    return Object.keys(this).length; 
  }
  
  has(key: indexType): boolean {
    return key in this || this.hasOwnProperty(key);
  }
  
  addNode(name: string, info: {}) {
    let [maxDepth, father]: [number, Node] = [0, null];
    for (const d of info['depends']) {
      const n = this[d] ?? Node.new(d, this);
      if (n.depth >= maxDepth) {
        father = n;
        maxDepth = n.depth;
      }
    }
    if (father) {
      return father.addChild(name, info);
    } else {
      return Node.new(name, this, info);
    }
  }

  async addModule(cr: Cursor, module: string, force?: string[]) {
    await this.addModules(cr, [module], force);
  }

  async addModules<T>(cr: Cursor, moduleList: string[], force?: any[]) {
    if (!force) {
      force = [];
    }
    const packages: [string, {}][] = [];
    const len = Object.keys(this).length;
    for (const module of moduleList) {
      const info = modules.loadInformationFromDescriptionFile(module);
      if (info && info['installable']) {
        packages.push([module, info]);
      } else if (module !== 'studioCustomization') {
        console.log('module %s: not installable, skipped', module);
      }
    }

    const dependencies = {};
    const current = new Set();
    for (const [p, info] of packages) {
      dependencies[p] = info['depends'];
      current.add(p);
    }
    const later = new Set<string>();
    
    while (packages.length && current.size > later.size) {
      const [pack, info] = packages[0];
      const deps: string[] = info['depends'] || [];

      // if all dependencies of 'package' are already in the graph, add 'package' in the graph
      if (deps.every((dep) => this.has(dep))) {
        if (!current.has(pack)) {
          packages.splice(0, 1);
          continue;
        }
        later.clear();
        current.delete(pack);
        const node = this.addNode(pack, info);
        const config = tools.config;
        for (const kind of ['init', 'demo', 'update']) {
          if (config.get(kind)[pack] || config.get(kind)['all'] || force.includes(kind)) {
            node[kind] = true;
          }
        }
      } else {
        later.add(pack);
        packages.push([pack, info]);
      }
      packages.splice(0, 1);
    }

    await this.updateFromDb(cr);
    for (const pack of later) {
      const unmetDeps = dependencies[pack].filter((p) => !this.has(p));
      console.log('module %s: unmet dependencies: %s', pack, unmetDeps.join(','))
    }

    return Object.keys(this).length - len;
  }

  *[Symbol.iterator] () {
    let level = 0;
    const done = new Set(Object.keys(this));
    while (done.size) {
      const levelModules = Object.entries(this)
      .filter(([x, module]) => module.depth == level)
      .sort((x, y) => {
        if (x[0] < y[0]) return -1;
        if (x[0] > y[0]) return 1;
        return 0;
      });
      for (const [name, module] of levelModules) {
        done.delete(name);
        yield module;
      }
      level += 1;
    }
  }

  toString() {
    return Object.values(this).filter((v) => v.depth == 0).map((v) => `${v}`).join('\n');
  }

  async updateFromDb(cr: Cursor) {
    if (this.length <= 0) {
      return;
    }

    const additionalData = {};
    Object.keys(this).forEach((key) => additionalData[key] = {'id': 0, 'state': 'uninstalled', 'dbdemo': false, 'installedVersion': null});

    const sql = `
      SELECT label, id, state, demo AS dbdemo, "latestVersion" AS "installedVersion"
      FROM "irModuleModule"
      WHERE label IN (${quoteList(Object.keys(additionalData))})
    `;
    const res = await cr.execute(sql);
    res.forEach((x) => additionalData[x['label']] = x);
    const values = Object.values(this);
    for (const pack of values) {
      const entries = Object.entries<any>(additionalData[pack.name]);
      for (const [k, v] of entries) {
        setattr(pack, k, v);
      }
    }
  }
}

export class Node extends Object {
  [index: string]: any;

  name: string;
  graph: Graph;
  info: {};
  children: Node[];
  depth: number;

  static new(name: string, graph: Graph, info?: {}) {
    let inst: Node;
    if (graph.has(name)) {
      inst = graph[name];
      inst._init(name, graph, info);
    } else {
      inst = new Node();
      inst._init(name, graph, info);
      graph[name] = inst;
    }
    return inst;
  }

  private _init(name: string, graph: Graph, info?: {}) {
    this.name = name;
    this.graph = graph;
    this.info = info ?? this.info ?? {};
    if (this.children === undefined) {
      this.children = [];
    }
    if (this.depth === undefined) {
      this._setattr('depth', 0);
    }
  }

  get data(): {} {
    return this.info;
  }

  addChild(name: string, info: {}) {
    const node = Node.new(name, this.graph, info);
    node._setattr('depth', this.depth + 1);
    if (this.children.includes(node)) {
      this.children.push(node);
    }
    for (const attr of ['init', 'update', 'demo']) {
      if (this[attr]) {
        node[attr] = true;
      }
    }
    this.children = sorted(this.children, (x) => x.name);
    return node;
  }

  _setattr(name: string, value: any) {
    this[name] = value;
    if (['init', 'update', 'demo'].includes(name)) {
      tools.config.get(name)[this.name] = 1
      for (const child of this.children) {
        child[name] = value;
      }
    }
    if (name === 'depth') { 
      for (const child of this.children) {
        child[name] = value + 1;
      }
    }
  }

  toString(): string {
    return this._pprint();
  }

  _pprint(depth=0): string {
    let s = `${this.name}\n`;
    for (const c of this.children) {
      s += `   ${depth} -> ${c._pprint(depth+1)}`;
    }
    return s;
  }

  shouldHaveDemo() {
    return (this.demo || (this.dbdemo && this.state !== 'installed')) 
      && this.parents.every((p) => p.dbdemo);
  }

  get parents() {
    const res: Node[] = [];
    if (this.depth == 0) {
      return res;
    }
    for (const node of Object.values(this.graph) as Node[]) {
      if (node.depth < this.depth && node.children.includes(this)) {
        res.push(node);
      }
    }
    return res;
  }
}