/**
 * https://github.com/federicobond/c3-linearization/tree/master
 */

const defaultOptions = {
  reverse: false,
  javascript: false,
  func: (key) => key
}

function merge(sequences) {
  let result = [];
  sequences = sequences.map(s => s.slice());

  while (sequences.length > 0) {
    let found = false;
    let head;

    for (let seq of sequences) {
      head = seq[0];

      function isBadHead(s) {
        return s !== seq && s.slice(1).includes(head);
      }

      if (!sequences.find(isBadHead)) {
        found = true;
        result.push(head);

        for (let seq of sequences) {
          const index = seq.indexOf(head);
          if (index > -1) {
            seq.splice(index, 1);
          }
        }

        break;
      }
    }

    sequences = sequences.filter(s => s.length > 0);

    if (!found) {
      throw new Error("cannot find C3-linearization for input");
    }
  }

  return result;
}

function _linearize(graph: Map<any, any>, head: any, results: Map<any, any>, visiting: Set<any>, options: {reverse?: boolean, javascript?: boolean, func?: Function}={}) {
  if (results.has(head)) {
    return results.get(head);
  }

  if (visiting.has(head)) {
    throw new Error('circular dependency found');
  }
  visiting.add(head);

  let parents = graph.get(head);
  
  if (!parents || parents.length == 0) {
    const res = [head];
    results.set(head, res);
    return res;
  }

  if (options.reverse === true) {
    parents = parents.slice().reverse();
  }

  const func = options.func;
  let sequences = parents.map(x => _linearize(graph, func(x), results, visiting, options));

  if (options.javascript === true) {
    sequences = sequences.concat([parents]);
  }

  const res = [head].concat(merge(sequences));
  results.set(head, res);

  visiting.delete(head);

  return res;
}

/**
 * 
 * @param graph: Object.fromEntries(Model.__bases.map(base => [base.classname, base]); 
 * @param options 
 * @returns 
 */
export function linearize(graph: Map<any, any>, options: {func?: Function}={}) {
  options = Object.assign({}, defaultOptions, options);

  const results = new Map<any, any>();
  const visiting = new Set<string>();
  const heads = graph.keys();

  for (let head of heads) {
    _linearize(graph, head, results, visiting, options);
  }

  return results;
}