/**
 * Diablo II 1.13c function pointers — vanilla only.
 * Offsets/ordinals from jcageman/d2mapapi (verified against our DLLs).
 */
#include "d2_structs.h"

#ifdef _DEFINE_VARS

enum {
    DLLNO_D2CLIENT,
    DLLNO_D2COMMON,
    DLLNO_D2GFX,
    DLLNO_D2LANG,
    DLLNO_D2WIN,
    DLLNO_D2NET,
    DLLNO_D2GAME,
    DLLNO_D2LAUNCH,
    DLLNO_FOG,
    DLLNO_BNCLIENT,
    DLLNO_STORM,
    DLLNO_D2CMP,
    DLLNO_D2MULTI,
    DLLNO_D2SOUND
};

#define DLLOFFSET(a1, b1) ((DLLNO_##a1) | ((b1) << 8))
#define FUNCPTR(d1, v1, t1, t2, o1) \
    typedef t1 d1##_##v1##_t t2;    \
    d1##_##v1##_t *d1##_##v1 = (d1##_##v1##_t *)DLLOFFSET(d1, o1);
#define VARPTR(d1, v1, t1, o1) \
    typedef t1 d1##_##v1##_t;  \
    d1##_##v1##_t *p_##d1##_##v1 = (d1##_##v1##_t *)DLLOFFSET(d1, o1);
#define ASMPTR(d1, v1, o1) DWORD d1##_##v1 = DLLOFFSET(d1, o1);

#else

#define FUNCPTR(d1, v1, t1, t2, o1) \
    typedef t1 d1##_##v1##_t t2;    \
    extern "C" d1##_##v1##_t *d1##_##v1;
#define VARPTR(d1, v1, t1, o1) \
    typedef t1 d1##_##v1##_t;  \
    extern d1##_##v1##_t *p_##d1##_##v1;
#define ASMPTR(d1, v1, o1) extern DWORD d1##_##v1;

#endif

/* ---- FOG.dll ---------------------------------------------------- */
FUNCPTR(FOG, 10021, VOID __fastcall, (CHAR *szProg), -10021)
FUNCPTR(FOG, 10101, DWORD __fastcall, (DWORD _1, DWORD _2), -10101)
FUNCPTR(FOG, 10089, DWORD __fastcall, (DWORD _1), -10089)
FUNCPTR(FOG, 10218, DWORD __fastcall, (VOID), -10218)

/* ---- D2Win.dll -------------------------------------------------- */
FUNCPTR(D2WIN, 10086, DWORD __fastcall, (VOID), -10086)
FUNCPTR(D2WIN, 10005, DWORD __fastcall, (DWORD _1, DWORD _2, DWORD _3, d2client_struct *pD2Client), -10005)

/* ---- D2Lang.dll ------------------------------------------------- */
FUNCPTR(D2LANG, 10008, DWORD __fastcall, (DWORD _1, CHAR *_2, DWORD _3), -10008)

/* ---- Storm.dll -------------------------------------------------- */
VARPTR(STORM, MPQHashTable, DWORD, 0x53120)
FUNCPTR(STORM, SFileOpenArchive, BOOL __stdcall, (const char *szMpqName, DWORD dwPriority, DWORD dwFlags, HANDLE *phMPQ), -266)

/* ---- D2Client.dll ----------------------------------------------- */
FUNCPTR(D2CLIENT, InitGameMisc, VOID __stdcall, (DWORD Dummy1, DWORD Dummy2, DWORD Dummy3), 0x4454B)
ASMPTR(D2CLIENT, LoadAct_1, 0x62AA0)
ASMPTR(D2CLIENT, LoadAct_2, 0x62760)

/* ---- D2Common.dll (all by ordinal for 1.13c) -------------------- */
FUNCPTR(D2COMMON, InitDataTables,  DWORD __stdcall,     (DWORD _1, DWORD _2, DWORD _3), -10943)
FUNCPTR(D2COMMON, LoadAct,         Act *__stdcall,      (DWORD ActNumber, DWORD MapId, DWORD Unk, DWORD Unk_2, DWORD Unk_3, DWORD Unk_4, DWORD TownLevelId, DWORD Func_1, DWORD Func_2), -10951)
FUNCPTR(D2COMMON, UnloadAct,       VOID __stdcall,      (Act *pAct), -10868)
FUNCPTR(D2COMMON, GetLevel,        Level *__fastcall,   (ActMisc *pMisc, DWORD dwLevelNo), -10207)
FUNCPTR(D2COMMON, InitLevel,       void __stdcall,      (Level *pLevel), -10322)
FUNCPTR(D2COMMON, AddRoomData,     void __stdcall,      (Act *ptAct, int LevelId, int Xpos, int Ypos, Room1 *pRoom), -10401)
FUNCPTR(D2COMMON, RemoveRoomData,  void __stdcall,      (Act *ptAct, int LevelId, int Xpos, int Ypos, Room1 *pRoom), -11099)
FUNCPTR(D2COMMON, GetLevelText,    LevelTxt *__stdcall, (DWORD levelno), -10014)
FUNCPTR(D2COMMON, GetObjectTxt,    ObjectTxt *__stdcall, (DWORD objno), -10688)

/* ---- Offset table bounds (used by DefineOffsets in offset.c) ---- */
#define _D2PTRS_START FOG_10021
#define _D2PTRS_END   D2COMMON_GetObjectTxt
