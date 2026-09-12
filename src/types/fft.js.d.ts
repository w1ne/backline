declare module 'fft.js' {
  export default class FFT {
    constructor(size: number);
    readonly size: number;
    createComplexArray(): number[];
    toComplexArray(input: ArrayLike<number>, storage?: number[]): number[];
    completeSpectrum(spectrum: ArrayLike<number>): void;
    transform(out: ArrayLike<number>, data: ArrayLike<number>): void;
    realTransform(out: ArrayLike<number>, data: ArrayLike<number>): void;
    inverseTransform(out: ArrayLike<number>, data: ArrayLike<number>): void;
  }
}
