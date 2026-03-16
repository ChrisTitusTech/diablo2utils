/**
 * Diablo II 1.13c — Act loading / D2Common wrappers.
 * All version-dispatch logic removed; calls go directly to D2Common ordinals.
 */
#ifndef D2_CLIENT_VERSION_H
#define D2_CLIENT_VERSION_H

#include "d2_ptrs.h"

/* Cache the recently generated acts; unload on seed/difficulty change */
static Act *acts[5] = {NULL, NULL, NULL, NULL, NULL};
static int act_seeds[5] = {0, 0, 0, 0, 0};
static int act_diff[5] = {-1, -1, -1, -1, -1};

/* Town level IDs per act (D2Common_LoadAct requires the correct town level) */
static const DWORD townLevelIds[5] = {1, 40, 75, 103, 109};

static Act *d2common_load_act_run(int actId, int seed, int difficulty) {
    DWORD townLevelId = (actId >= 0 && actId < 5) ? townLevelIds[actId] : 1;
    return D2COMMON_LoadAct(actId, seed, TRUE, FALSE, difficulty, (DWORD)NULL,
                            townLevelId, D2CLIENT_LoadAct_1, D2CLIENT_LoadAct_2);
}

static void d2common_unload_act(Act *pAct) {
    D2COMMON_UnloadAct(pAct);
}

static Act *d2common_load_act(int actId, int seed, int difficulty) {
    if (act_seeds[actId] == seed && act_diff[actId] == difficulty) return acts[actId];
    if (acts[actId] != NULL) d2common_unload_act(acts[actId]);

    Act *pAct = d2common_load_act_run(actId, seed, difficulty);
    act_seeds[actId] = seed;
    act_diff[actId] = difficulty;
    acts[actId] = pAct;
    return pAct;
}

static inline LevelTxt *d2common_get_level_text(int levelCode) {
    return D2COMMON_GetLevelText(levelCode);
}

static inline void d2common_init_level(Level *pLevel) {
    D2COMMON_InitLevel(pLevel);
}

static inline void d2common_add_room_data(Act *pAct, Level *pLevel, Room2 *pRoom2) {
    D2COMMON_AddRoomData(pAct, pLevel->dwLevelNo, pRoom2->dwPosX, pRoom2->dwPosY, NULL);
}

static inline void d2common_remove_room_data(Act *pAct, Level *pLevel, Room2 *pRoom2) {
    D2COMMON_RemoveRoomData(pAct, pLevel->dwLevelNo, pRoom2->dwPosX, pRoom2->dwPosY, NULL);
}

static inline Level *d2common_get_level(ActMisc *misc, DWORD levelCode) {
    return D2COMMON_GetLevel(misc, levelCode);
}

static inline ObjectTxt *d2common_get_object_txt(DWORD dwTxtFileNo) {
    return D2COMMON_GetObjectTxt(dwTxtFileNo);
}

#endif
