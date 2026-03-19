import { Act, Difficulty } from '@diablo2/data';
import { Request, Response, Route } from '../route.js';

export interface GameStatePlayer {
  x: number;
  y: number;
  name?: string;
  level?: number;
  life?: number;
}

export interface GameStateUnit {
  id: number;
  x: number;
  y: number;
  type: string;
  name?: string;
  code?: number | string;
  life?: number;
}

export interface GameStateItem {
  id: number;
  x: number;
  y: number;
  type: string;
  name?: string;
  code?: string;
  quality?: { id: number; name: string };
  seenAt?: number;
  sockets?: number;
  isEthereal?: boolean;
  isIdentified?: boolean;
  isRuneWord?: boolean;
}

export interface GameStateKill {
  code: number;
  name: string;
  total: number;
}

export interface GameState {
  seed: number;
  difficulty: number;
  act: number;
  levelId?: number;
  updatedAt: number;
  player?: GameStatePlayer | null;
  units?: GameStateUnit[];
  items?: GameStateItem[];
  kills?: GameStateKill[];
}

/** In-memory game state, updated by the memory reader via POST /v1/state */
export const currentGameState: GameState = {
  seed: 0,
  difficulty: Difficulty.Hell,
  act: Act.ActI,
  levelId: 0,
  updatedAt: 0,
};

/** GET /v1/state — returns the current game state to the viewer */
export class StateGetRoute implements Route<GameState> {
  url = '/v1/state';
  async process(_req: Request, res?: Response): Promise<GameState> {
    res?.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res?.setHeader('Pragma', 'no-cache');
    res?.setHeader('Expires', '0');
    return currentGameState;
  }
}
