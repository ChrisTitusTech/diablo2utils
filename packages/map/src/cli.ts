import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { Log } from './logger.js';
import { Diablo2Path, MapCluster } from './map/map.process.js';
import { MapServer } from './server.js';

if (!fs.existsSync(Diablo2Path)) Log.warn({ path: Diablo2Path }, 'Diablo2Path:Missing');

const wwwDir = path.join(__dirname, 'www');
MapServer.server.use(express.static(wwwDir));

if (process.env['DIABLO2_CLUSTER_SIZE']) {
  const clusterSize = Number(process.env['DIABLO2_CLUSTER_SIZE']);
  if (!isNaN(clusterSize)) MapCluster.ProcessCount = clusterSize;
}

MapServer.init().catch((e) => {
  Log.fatal({ error: e }, 'Uncaught Exception');
});
