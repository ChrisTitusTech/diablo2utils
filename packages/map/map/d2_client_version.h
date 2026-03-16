#include "d2_ptrs.h"
#include "d2_version.h"

/* Cache the recently generated acts if they change unload it */
Act* acts[5] = {NULL, NULL, NULL, NULL, NULL};
int act_seeds[5] = {0,0,0,0,0};
int act_diff[5] = {-1,-1,-1,-1,-1};

/* Town level IDs per act (D2Common_LoadAct requires the correct town level) */
static const DWORD townLevelIds[5] = { 1, 40, 75, 103, 109 };

/* LoadAct callbacks for vanilla headless map generation.
   Func_1 (ActMisc+0x454): called per-level with 1 arg (dwLayerNo). __stdcall, ret $0x4.
   Func_2 (ActMisc+0x488): called for town levels 40,103,109 (Acts 2,4,5) with
   4 args (levelNo, unk, centerY, centerX). __stdcall, ret $0x10.
   Both return 0 (NULL automap layer) in headless mode. */
DWORD __stdcall loadact_stub_initlayer(DWORD nLayerNo) { (void)nLayerNo; return 0; }
DWORD __stdcall loadact_stub_initlayer2(DWORD a, DWORD b, DWORD c, DWORD d) { (void)a; (void)b; (void)c; (void)d; return 0; }

Act* d2common_load_act_run(D2Version gameVersion, int actId, int seed, int difficulty) {
    DWORD townLevelId = (actId >= 0 && actId < 5) ? townLevelIds[actId] : 1;
    if (gameVersion == VersionPathOfDiablo) return D2COMMON_Pod_LoadAct(actId, seed, TRUE, FALSE, difficulty, (DWORD)NULL, townLevelId, D2CLIENT_Pod_LoadAct_1, D2CLIENT_Pod_LoadAct_2);
    if (gameVersion == VersionProjectDiablo2) return D2COMMON_Pd2_LoadAct(actId, seed, TRUE, FALSE, difficulty, (DWORD)NULL, townLevelId, D2CLIENT_Pd2_LoadAct_1, D2CLIENT_Pd2_LoadAct_2);
    if (gameVersion == VersionDiablo2) return D2COMMON_Pod_LoadAct(actId, seed, TRUE, FALSE, difficulty, (DWORD)NULL, townLevelId, (DWORD)loadact_stub_initlayer, (DWORD)loadact_stub_initlayer2);
    return NULL;
}
void d2common_unload_act(D2Version gameVersion, Act* pAct) {
    if (gameVersion == VersionPathOfDiablo) return D2COMMON_Pod_UnloadAct(pAct);
    if (gameVersion == VersionProjectDiablo2) return D2COMMON_Pd2_UnloadAct(pAct);
    if (gameVersion == VersionDiablo2) return D2COMMON_Pod_UnloadAct(pAct);
}

Act* d2common_load_act(D2Version gameVersion, int actId, int seed, int difficulty) {
    /** Cache hit */
    if (act_seeds[actId] == seed && act_diff[actId] == difficulty) return acts[actId];
    /** Seed or difficulty has changed unload old act */
    if (acts[actId] != NULL) d2common_unload_act(gameVersion, acts[actId]);

    Act* pAct = d2common_load_act_run(gameVersion, actId, seed, difficulty);
    act_seeds[actId] = seed;
    act_diff[actId] = difficulty;
    acts[actId] = pAct;

    return pAct;
}

LevelTxt* d2common_get_level_text(D2Version gameVersion, int levelCode) {
    if (gameVersion == VersionPathOfDiablo) return D2COMMON_Pod_GetLevelText(levelCode);
    if (gameVersion == VersionProjectDiablo2) return  D2COMMON_Pd2_GetLevelText(levelCode);
    if (gameVersion == VersionDiablo2) return  D2COMMON_Pod_GetLevelText(levelCode);
    return NULL;
}

void d2common_init_level(D2Version gameVersion, Level* pLevel) {
    if (gameVersion == VersionPathOfDiablo) return D2COMMON_Pod_InitLevel(pLevel);
    if (gameVersion == VersionProjectDiablo2) return D2COMMON_Pd2_InitLevel(pLevel);
    if (gameVersion == VersionDiablo2) return D2COMMON_Pod_InitLevel(pLevel);
}

void d2common_add_room_data(D2Version gameVersion, Act* pAct, Level* pLevel, Room2* pRoom2) {
    if (gameVersion == VersionPathOfDiablo) return D2COMMON_Pod_AddRoomData(pAct, pLevel->dwLevelNo, pRoom2->dwPosX, pRoom2->dwPosY, NULL);
    if (gameVersion == VersionProjectDiablo2) return D2COMMON_Pd2_AddRoomData(pAct, pLevel->dwLevelNo, pRoom2->dwPosX, pRoom2->dwPosY, NULL);
    if (gameVersion == VersionDiablo2) return D2COMMON_Pod_AddRoomData(pAct, pLevel->dwLevelNo, pRoom2->dwPosX, pRoom2->dwPosY, NULL);
}

void d2common_remove_room_data(D2Version gameVersion, Act* pAct, Level* pLevel, Room2* pRoom2) {
    if (gameVersion == VersionPathOfDiablo) return D2COMMON_Pod_AddRoomData(pAct, pLevel->dwLevelNo, pRoom2->dwPosX, pRoom2->dwPosY, NULL);
    if (gameVersion == VersionProjectDiablo2) return D2COMMON_Pd2_AddRoomData(pAct, pLevel->dwLevelNo, pRoom2->dwPosX, pRoom2->dwPosY, NULL);
    if (gameVersion == VersionDiablo2) return D2COMMON_Pod_AddRoomData(pAct, pLevel->dwLevelNo, pRoom2->dwPosX, pRoom2->dwPosY, NULL);
}

Level* d2common_get_level(D2Version gameVersion, ActMisc *misc, DWORD levelCode) {
    if (gameVersion == VersionPathOfDiablo) return D2COMMON_Pod_GetLevel(misc, levelCode);
    if (gameVersion == VersionProjectDiablo2) return D2COMMON_Pd2_GetLevel(misc, levelCode);
    if (gameVersion == VersionDiablo2) return D2COMMON_Pod_GetLevel(misc, levelCode);
    return NULL;
}

ObjectTxt* d2common_get_object_txt(D2Version gameVersion, DWORD dwTxtFileNo) {
    if (gameVersion == VersionPathOfDiablo) return D2COMMON_Pod_GetObjectTxt(dwTxtFileNo);
    if (gameVersion == VersionProjectDiablo2) return D2COMMON_Pd2_GetObjectTxt(dwTxtFileNo);
    if (gameVersion == VersionDiablo2) return D2COMMON_Pod_GetObjectTxt(dwTxtFileNo);
    return NULL;
}
