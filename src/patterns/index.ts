import type { Genre, Instrument, Pattern } from '../types';
import { lofi } from './lofi';
import { funk } from './funk';
import { rock } from './rock';
import { jazz } from './jazz';
export const PATTERNS: Record<Genre, Record<Instrument, Pattern>> = { lofi, funk, rock, jazz };
