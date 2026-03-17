import { bp, StrutInfer } from 'binparse';
import { Pointer } from './pointer.js';
const { at, lu32, u8 } = bp;

export const D2rRoomStrut = bp.object('Room', {
  pRoomNear: at(0x00, new Pointer(u8)),
  pRoomExt: at(0x18, new Pointer(u8)),
  roomNearCount: at(0x40, lu32),
  pAct: at(0x48, new Pointer(u8)),
  pUnitFirst: at(0xa8, new Pointer(u8)),
  pRoomNext: at(0xb0, new Pointer(u8)),
});

D2rRoomStrut.setSize(0xb8);

export const D2rRoomExStrut = bp.object('RoomEx', {
  pLevel: at(0x90, new Pointer(u8)),
});

D2rRoomExStrut.setSize(0x98);

export const D2rLevelStrut = bp.object('Level', {
  levelId: at(0x1f8, lu32),
});

D2rLevelStrut.setSize(0x200);

export const RoomPointer = new Pointer(D2rRoomStrut);

export type RoomS = StrutInfer<typeof D2rRoomStrut>;
export type RoomExS = StrutInfer<typeof D2rRoomExStrut>;
export type LevelS = StrutInfer<typeof D2rLevelStrut>;
