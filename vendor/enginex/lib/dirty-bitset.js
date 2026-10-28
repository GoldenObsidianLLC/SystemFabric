'use strict';

/** A compact bitset that scales beyond JavaScript's 32-bit bitwise operators. */
class DirtyBitSet {
  constructor(size, words) {
    if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('Bitset size must be a non-negative safe integer.');
    this.size = size;
    this.words = words ? new Uint32Array(words) : new Uint32Array(Math.ceil(size / 32));
    if (this.words.length !== Math.ceil(size / 32)) throw new RangeError('Bitset word array does not match its size.');
  }
  set(index) { this.#check(index); this.words[index >>> 5] |= (1 << (index & 31)) >>> 0; return this; }
  clear(index) { this.#check(index); this.words[index >>> 5] &= ~((1 << (index & 31)) >>> 0); return this; }
  has(index) { this.#check(index); return Boolean(this.words[index >>> 5] & ((1 << (index & 31)) >>> 0)); }
  reset() { this.words.fill(0); return this; }
  fill() { this.words.fill(0xffffffff); const remainder = this.size & 31; if (remainder && this.words.length) this.words[this.words.length - 1] &= (2 ** remainder - 1) >>> 0; return this; }
  clone() { return new DirtyBitSet(this.size, this.words); }
  or(other) { this.#assertSame(other); const result = new DirtyBitSet(this.size); for (let i = 0; i < this.words.length; i++) result.words[i] = this.words[i] | other.words[i]; return result; }
  and(other) { this.#assertSame(other); const result = new DirtyBitSet(this.size); for (let i = 0; i < this.words.length; i++) result.words[i] = this.words[i] & other.words[i]; return result; }
  xor(other) { this.#assertSame(other); const result = new DirtyBitSet(this.size); for (let i = 0; i < this.words.length; i++) result.words[i] = this.words[i] ^ other.words[i]; return result; }
  xorInPlace(other) { this.#assertSame(other); for (let i = 0; i < this.words.length; i++) this.words[i] ^= other.words[i]; return this; }
  intersects(other) { this.#assertSame(other); for (let i = 0; i < this.words.length; i++) if ((this.words[i] & other.words[i]) !== 0) return true; return false; }
  isEmpty() { for (const word of this.words) if (word !== 0) return false; return true; }
  indices() { const found = []; for (let i = 0; i < this.size; i++) if (this.has(i)) found.push(i); return found; }
  toJSON() { return { size: this.size, words: Array.from(this.words, value => value >>> 0) }; }
  #check(index) { if (!Number.isSafeInteger(index) || index < 0 || index >= this.size) throw new RangeError(`Bit index ${index} is outside a bitset of size ${this.size}.`); }
  #assertSame(other) { if (!(other instanceof DirtyBitSet) || other.size !== this.size) throw new TypeError('Bitsets must have equal sizes.'); }
}

function pathMatchesDependency(dependency, changedPath) {
  if (dependency === '*' || changedPath === '*' || dependency === changedPath) return true;
  const depParts = dependency.split('.');
  const changedParts = changedPath.split('.');
  let index = 0;
  while (index < depParts.length && index < changedParts.length) {
    if (depParts[index] !== '*' && depParts[index] !== changedParts[index]) return false;
    index++;
  }
  // A dependency on an object/collection is invalidated by descendant changes.
  return index === depParts.length || index === changedParts.length;
}

class FragmentDependencyGraph {
  constructor(fragments = []) {
    this.fragments = fragments;
    this.paths = [...new Set(fragments.flatMap(fragment => fragment.dependencies || []))].sort();
    this.pathIndexes = new Map(this.paths.map((path, index) => [path, index]));
    this.fragmentMasks = fragments.map(fragment => {
      const mask = new DirtyBitSet(this.paths.length);
      for (const dependency of fragment.dependencies || []) {
        const index = this.pathIndexes.get(dependency);
        if (index !== undefined) mask.set(index);
      }
      return mask;
    });
  }
  changedDependencyMask(changedPaths) {
    const mask = new DirtyBitSet(this.paths.length);
    for (const dependency of this.paths) {
      if (changedPaths.some(changedPath => pathMatchesDependency(dependency, changedPath))) mask.set(this.pathIndexes.get(dependency));
    }
    return mask;
  }
  dirtyFragmentMask(changedPaths) {
    const changedMask = this.changedDependencyMask(changedPaths);
    const mask = new DirtyBitSet(this.fragments.length);
    for (let index = 0; index < this.fragments.length; index++) {
      if (this.fragments[index].alwaysDirty || this.fragmentMasks[index].intersects(changedMask)) mask.set(index);
    }
    return mask;
  }
  select(changedPaths) { return this.dirtyFragmentMask(changedPaths).indices().map(index => this.fragments[index]); }
}

module.exports = { DirtyBitSet, FragmentDependencyGraph, pathMatchesDependency };
