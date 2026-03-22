// Global fetch is available in Node 18+ but @types/node@16 doesn't declare it
declare function fetch(url: string, init?: {
  headers?: Record<string, string>;
  method?: string;
  body?: string;
}): Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;
