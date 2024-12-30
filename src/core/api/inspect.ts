export const parameterfy = (function () {
    var pattern = /function[^(]*\(([^)]*)\)/;

    return function (func) {
        var args = func.toString().match(pattern)[1].split(/,\s*/);

        return function () {
            var named_params = arguments[arguments.length - 1];
            if (typeof named_params === 'object') {
                var params = [].slice.call(arguments, 0, -1);
                if (params.length < args.length) {
                    for (var i = params.length, l = args.length; i < l; i++) {
                        params.push(named_params[args[i]]);
                    }
                    return func.apply(null, params);
                }
            }
            return func.apply(null, arguments);
        };
    };
}());

/* DEMO
var foo = parameterfy(function(a, b, c,) {
  console.log('a is ' + a, ' | b is ' + b, ' | c is ' + c);     
});

foo(1,2,3);
foo(1, {b:2, c:3});
foo(1, {c:3});
foo({a: 1, c:3});
*/