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
  sockets?: number;
  isEthereal?: boolean;
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
  updatedAt: number;
  player?: GameStatePlayer;
  units?: GameStateUnit[];
  items?: GameStateItem[];
  kills?: GameStateKill[];
}

/** In-memory game state, updated by the memory reader via POST /v1/state */
export const currentGameState: GameState = {
  seed: 0,
  difficulty: Difficulty.Hell,
  act: Act.ActI,
  updatedAt: 0,
};

/** GET /v1/state — returns the current game state to the viewer */
export class StateGetRoute implements Route<GameState> {
  url = '/v1/state';
  async process(): Promise<GameState> {
    return currentGameState;
  }
}
