import { bp, StrutInfer } from 'binparse';
import { Pointer } from './pointer.js';

const { at, lu32, u8, lu64 } = bp;

/**
 * D2R ActMisc struct – offsets aligned with PrimeMH (latest D2R patch).
 *
 * Layout (PrimeMH reference):
 *   0x120  tombLevel        u32
 *   0x830  difficulty       u32   (was lu16 – corrected to match D2R)
 *   0x840  initSeedHash     u64
 *   0x860  endSeedHash      u32   (was 0x868 – shifted when pAct@0x860 was removed)
 */
export const D2rActMiscStrut = bp.object('D2rActMisc', {
  tombLevel: at(0x120, lu32),
  difficulty: at(0x830, lu32),
  initSeedHash: at(0x840, lu64),
  endSeedHash: at(0x860, lu32),
});
D2rActMiscStrut.setSize(0x864);
export type ActMiscS = StrutInfer<typeof D2rActMiscStrut>;

/**
 * D2R Act struct – pActMisc moved from 0x78 → 0x70 per PrimeMH.
 */
export const D2rActStrut = bp.object('Act', {
  mapSeed: at(0x1c, lu32),
  actId: at(0x28, lu32),
  pActMisc: at(0x70, new Pointer(D2rActMiscStrut)),
});
D2rActStrut.setSize(0x78);
export type ActS = StrutInfer<typeof D2rActStrut>;
