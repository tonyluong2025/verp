export class Speedscope extends Function {
  
  name: string;
  
  constructor(name?: string, initStackTrace?: any) {
    super();
    this.name = name ?? 'Speedscope';
    return new Proxy(this, {

    });
  }

  add(arg0: string, arg1: any) {
    throw new Error("Method not implemented.");
  }
  
  addDefault(): any {
    throw new Error("Method not implemented.");
  }
}