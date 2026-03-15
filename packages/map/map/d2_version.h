#include <stdio.h>
#include <windows.h>

#ifndef D2_VERSION_H
#define D2_VERSION_H
#include "log.h"

enum D2Version {
    VersionUnknown,
    VersionDiablo2
};

CHAR* Path_Diablo2 = (CHAR*)""; // vanilla 1.13c — no subdirectory

/** Convert the D2Version to the path that the files are normally located in */
char* game_version_path(D2Version version) {
    if (version == VersionDiablo2) return "";
    return NULL;
}

/** Determine if a a version of the game exists in the path by checking for Game.exe */
bool game_version_exists(char* folderName, D2Version version) {
    char gamePathExe[MAX_PATH];
    char* gamePath = game_version_path(version);
    if (gamePath == NULL) return false;

    sprintf(gamePathExe, "%s\\%sGame.exe", folderName, gamePath);

    std::ifstream ifs(gamePathExe, std::ifstream::in);
    bool found = !ifs;
    ifs.close();
    log_trace("Init:GamePath", lk_b("exists", !found), lk_s("game", gamePathExe)); 
    return !found;
}

/** Attempt to determine which version is installed */
D2Version game_version(char* folderName) {
    if (game_version_exists(folderName, VersionDiablo2)) return VersionDiablo2;
    return VersionUnknown;
}
#endif