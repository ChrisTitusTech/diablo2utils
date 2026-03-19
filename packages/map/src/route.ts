import type * as express from 'express';
import { LogType } from './logger.js';

export interface Request extends express.Request {
  id: string;
  log: LogType;
}

export type Response = express.Response;

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export interface Route<T = unknown> {
  url: string;
  contentType?: string;
  process(req: Request, res?: Response): Promise<T>;
}
