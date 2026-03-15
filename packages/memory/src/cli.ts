import { Diablo2MpqLoader } from '@diablo2/bintools';
import { Difficulty } from '@diablo2/data';
import de from 'dotenv';
import 'source-map-support/register.js';
import { Diablo2Process } from './d2.js';
import { Log } from './logger.js';
import { Diablo2GameSessionMemory } from './session.js';

de.config();

function usage(err?: string): void {
  if (err) console.log(`Error ${err} \n`);
  console.log('Usage: reader :playerName\n');
}

function getPlayerName(): string | null {
  for (let i = process.argv.length - 1; i >= 0; i--) {
    const arg = process.argv[i];
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return null;
}

async function main(): Promise<void> {
  if (process.argv.length < 3) return usage();

  const playerName = getPlayerName();
  if (playerName == null) return usage('Missing player name');

  if (process.env['DIABLO2_PATH']) await Diablo2MpqLoader.load(process.env['DIABLO2_PATH'], Log);

  const proc = await Diablo2Process.find();

  Log.info({ procId: proc.process.pid }, 'Process:Found');
  const session = new Diablo2GameSessionMemory(proc, playerName);

  // When the map seed changes, log a URL for the @diablo2/map server so the
  // current map layout can be viewed immediately in a browser.
  // Set MAP_SERVER_URL env var to override the default (e.g. "http://localhost:8899").
  const mapServerUrl = (process.env['MAP_SERVER_URL'] ?? 'http://localhost:8899').replace(/\/$/, '');
  session.onMapChange = (seed: number, difficulty: Difficulty, act: number): void => {
    const diffStr = Difficulty[difficulty].toLowerCase();
    const url = `${mapServerUrl}/v1/map/${seed}/${diffStr}/${act}.json`;
    Log.info({ seed, difficulty: Difficulty[difficulty], act, url }, 'Map:Changed');
    console.log(`\n  Map layout: ${url}\n`);
  };

  await session.start(Log);
}

main().catch((e) => Log.fatal(e, 'FailedToRun'));
