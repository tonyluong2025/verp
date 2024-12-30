const CARRIAGE_RETURN = /\n/;
const TAB = /\t/;
const EOL = /\r/;
const WHITESPACE = /\s/;
const ASTRIX = /[*]/

/**
 * Any assignable character
 */
const ASSIGNABLE_CHARACTERS = /[^\s\n\t\r,.;(){}[\]=]/;

/**
 * Match all special characters except underscore and semicolon... and whitespace.. and tabs... and newlines
 */
const SPECIAL_CHARACTERS = /[^a-zA-Z0-9_;\s\n\t\r]/;

export const tokenize = function (input: string, current=0, exitOn='') {
	const verbose = true;
	let lineNumber = 0;
	let assigner = false;

	function log(message) {
		if (verbose) {
			return console.log(message);
		}
	}

	function maybeBackTickStringCheck(char, input, current) {
		const BACK_TICK = /`/
		if (BACK_TICK.test(char)) {
			let value = "`";
			char = input[++current];
			while (!BACK_TICK.test(char)) {
				value += char;
				char = input[++current];
			}
			value += "`";
			char = input[++current];
			return { type: 'stringLiteral', value, current };
		}
		return { type: '', value: '', current }
	}

	function stringConditional(condition, char, input, current) {
		// capture the quotes and the value inside  double/single quotes
		if (char === condition) {

			let value = condition;
			char = input[++current];
			while (char !== condition) {
				value += char;
				char = input[++current];
			}
			value += condition;

			char = input[++current];
			return { type: 'string', value, current };
		}
		return { type: '', value: '' }
	}

	function start(input, current, exitOn) {
		if (!input) {
			throw new Error('No Input string provided');
		}

		current = current || 0;
		let tokens = [];
		let char = input[current];

		while (current < input.length) {

			char = input[current];
			log(`Checking: ${char}`);
			if (char === exitOn) {
				log(`exiting ${exitOn}`);
				//check for space after the exit condition
				if (exitOn === ';') {
					tokens.push({ type: 'statementseperator', value: char });
				}
				if (exitOn === "}" && input[current + 1] === ';') {
					current = current++;
				}
				break;
			}

			if (char === '(') {
				log(`Enter ${char}`);
				log("entering " + char);
				char = input[++current];
				let results = start(input, current, ')');
				tokens.push({ type: 'params', value: results.tokens });
				current = results.current;
				char = input[++current];
				continue;
			}

			//arr
			if (char === '[') {
				log(`Enter ${char}`);
				char = input[++current];
				let results = start(input, current, ']');
				tokens.push({ type: 'array', value: results.tokens });
				current = results.current;
				char = input[++current];
				continue;
			}

			//body
			if (char === '{') {
				log(`Enter ${char}`);
				char = input[++current];
				let results = start(input, current, '}');
				tokens.push({ type: 'codeblock', value: results.tokens });
				current = results.current;
				char = input[++current];
				continue;
			}

			const isNewLine = (char) => {
				log(`Newline check ${char}`);
				let newLine = false;
				if (EOL.test(char)) {
					lineNumber = (lineNumber + 1);
					tokens.push({ type: 'eol', value: char });
					newLine = true;
				}
				if (CARRIAGE_RETURN.test(char)) {
					lineNumber = (lineNumber + 1);
					tokens.push({ type: 'carriagereturn', value: char });
					newLine = true;
				}
				log(`Newline: ${newLine}`);
				return newLine;
			}

			//test for cr and lf
			if (isNewLine(char)) {
				current++;
				continue;
			}

			if (TAB.test(char)) {
				tokens.push({ type: 'tab', value: '\t' });
				current++;
				continue;
			}

			if (WHITESPACE.test(char)) {
				tokens.push({ type: 'space', value: ' ' });
				current++;
				continue;
			}

			const doubleQuotedString = stringConditional(
				'"',
				char,
				input,
				current
			);
			if (doubleQuotedString.type) {
				const {type, value} = doubleQuotedString;
				tokens.push({type, value});
				current = doubleQuotedString.current;
				char = input[current];
				assigner = false;
				continue;
			}

			const singleQuotedString = stringConditional(
				"'",
				char,
				input,
				current
			);
			if (singleQuotedString.type) {
        const {type, value, current} = singleQuotedString;
				tokens.push({type, value});
				char = input[current];
				assigner = false;
				continue;
			}

			const backTickString = maybeBackTickStringCheck(
				char,
				input,
				current
			);
			if (backTickString.type) {
				const { type, value, current} = backTickString;
				tokens.push( { type, value});
				char = input[current];
				assigner = false;
				continue;
			}


			//check for assignment call
			if (char === "=") {
				let newCurrent = (current + 1)
				let token = { type: 'assigner', value: char };
				const nextChar = input[current + 1]
				//if the next char is '=' then its an equality check
				if (nextChar === '=') {
					newCurrent = (newCurrent + 1);
					let equalityComparator = char + '=';
					if (input[current + 2] === '=') {
						equalityComparator += "=";
						newCurrent = (newCurrent + 1);
					}
					token.type = 'operator';
					token.value = equalityComparator;
				}
				else if (nextChar === '>') {
					token.type = 'arrow';
					token.value = '=>';
					newCurrent = (newCurrent + 1);
				}
				current = newCurrent;
				tokens.push(token);
				assigner = true;
				continue;
			}

			//if we have an assignment flag, then push any non whitespace chars into a new token until we reach a whitespace
			if (assigner && ASSIGNABLE_CHARACTERS.test(char)) {
				let value = '';
				while (ASSIGNABLE_CHARACTERS.test(char) && char !== undefined) {
					value += char;
					char = input[++current];
				}
				log(value);
				tokens.push({ type: 'assignee', value: value });
				assigner = false;
				continue;
			}

			if (char === ',') {
				tokens.push({ type: 'seperator', value: char });
				char = input[++current];
				continue;
			}
			if (char === ';') {
				log("end of line" + char);
				tokens.push({ type: 'statementseperator', value: char });
				char = input[++current];
				continue;
			}

			//inline comment
			if (char === "/" && input[current + 1] == "/") {
				let value = '';
				while (!isNewLine(char) && char !== undefined) {
					value += char;
					char = input[++current];
				}
				tokens.push({ type: 'inlinecomment', value });
				continue;
			}

			//multi line comment, should be two astrix, but since ...some people... use /* instead of  /**, we catch both
			if (char === "/" && input[current + 1] === "*") {
				let value = '';
				const closing = "*/";
				let aheadText = ''

				//skip the astrix stuff
				current = (current + 1);
				char = input[current];
				while (ASTRIX.test(char)) {
					char = input[++current];
				}

				//we got this far we no long have astrixesnow we do it until the look ahead
				while (closing !== aheadText) {
					value += char;
					char = input[++current];
					aheadText = char + input[current + 1];
				}
				tokens.push({ type: 'multilinecomment', value: "/**" + value + closing });
				current = (current + 2);
				continue;
			}

			//check for operators
			if (SPECIAL_CHARACTERS.test(char)) {
				let value = '';
				const type = 'operator';
				while (SPECIAL_CHARACTERS.test(char) && char !== undefined) {
					value += char;
					char = input[++current];
				}
				tokens.push({ type, value });
				continue;
			}
			//declarations must start with a alpha character, however, afterwards it can contain numbers (check the while decl)
			if (ASSIGNABLE_CHARACTERS.test(char)) {
				let value = '';
				while (ASSIGNABLE_CHARACTERS.test(char) && char !== undefined) {
					value += char;
					char = input[++current];
				}
				log(value);

				//check name for reserved
				switch (value) {
					case "const":
					case "var":
					case "let":
						{
							log("entering ");
							const results = start(input, current, ';');
							tokens.push({ type: value, value: results.tokens });
							current = results.current;
							char = input[++current];
							break;
						}
					default:
						{
							let type = (assigner) ? 'assignee' : 'name';
							assigner = false;
							tokens.push({ type, value });
							break;
						}
				}
				continue;
			}

			log(`DEBUG current curser ${current}, last cursor ${input.length} current char ${char}, recursive exit condition is ${exitOn}`);
			throw new TypeError('unknown var type: ' + char);
		}
		return { tokens, current };
	};

  return start(input, current, exitOn).tokens;
};

export const parse = function (tokens: any[]) {
  function start(tokens) {
		return tokens.reduce((content, token) => {
			//check operator positioning
			switch (token.type) {
				case "assigner":
				case "seperator":
				case "operator":
				case "arrow":
				case "number":
				case "name":
				case "tab":
				case "eol":
				case "carriagereturn":
				case "string":
				case "stringLiteral":
				case "assignee":
				case "statementseperator":
				case "inlinecomment":
				case "multilinecomment":
				case "space": {
						return content += token.value;
					}
				case "const":
				case "var":
				case "let":
				case "import":
					{
						return content += `${token.type}${start(token.value)}`;
					}
				case "params":
					{
						return content += `(${start(token.value)})`;
					}
				case "array":
					{
						return content += `[${start(token.value)}]`;
					}
				case "codeblock":
					{
						return content += `{${start(token.value)}}`;
					}
				default:
					{
						throw new TypeError('Unable to parse unknown type' + token.type);
					}
			}
		}, "");
	}

  return start(tokens);
}