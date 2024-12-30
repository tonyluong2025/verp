export class AST {
  static Identifier(name: string) {
    return { type: "Identifier", name: name }
  }

  static Literal(value: any) {
    return { type: "Literal", value: value } 
  }

  static Object(properties: {}) {
    return { type: "ObjectExpression", properties: properties } 
  }

  static Array(elements: {}[]) {
    return { type: "ArrayExpression", elements: elements } 
  }

  static Member(object: {}, property: {}) {
    return { type: "MemberExpression", object: object, property: property } 
  }

  static Block(body: {}) {
    return { type: "BlockStatement", body: body } 
  }

  static Return(argument: {}) {
    return { type: "ReturnStatement", argument: argument } 
  }

  static Property(key: {}, value: {}) {
    return { type: "Property", key: key, value: value}
  }

  static Assignment(left: {}, right: {}) {
    return { type: "AssignmentPattern", left: left, right: right}
  }
}