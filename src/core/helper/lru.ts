export class LRU<T> extends Map<T, any> {
  private _count: number;

  constructor(count: number) {
    super();
    this._count = count;
  }
}