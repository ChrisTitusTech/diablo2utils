import { bp, StrutInfer } from 'binparse';
import { Pointer } from './pointer.js';

const { at, lu32, u8, lu16, lu64 } = bp;

export const D2rActMiscStrut = bp.object('D2rActMisc', {
  tombLevel: at(0x120, lu32),
  difficulty: at(0x830, lu16),
  initSeedHash: at(0x840, lu64),
  pAct: at(0x860, new Pointer(u8)),
  endSeedHash: at(0x868, lu32),
  pLevelFirst: at(0x870, new Pointer(u8)),
});
D2rActMiscStrut.setSize(0x878);
export type ActMiscS = StrutInfer<typeof D2rActMiscStrut>;

export const D2rActStrut = bp.object('Act', {
  mapSeed: at(0x1c, lu32),
  // unk1: at(0x08, new Pointer(bp.u8)),
  actId: at(0x28, lu32),
  pActMisc: at(0x78, new Pointer(D2rActMiscStrut)),
});
D2rActStrut.setSize(0x80);
export type ActS = StrutInfer<typeof D2rActStrut>;
