import { Act, Difficulty } from '@diablo2/data';
import { Request, Response, Route } from '../route.js';

export interface GameState {
  seed: number;
  difficulty: number;
  act: number;
  updatedAt: number;
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
