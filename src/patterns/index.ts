import type { Genre, Instrument, Pattern } from '../types';
import { lofi } from './lofi';
export const PATTERNS: Partial<Record<Genre, Record<Instrument, Pattern>>> = { lofi };
