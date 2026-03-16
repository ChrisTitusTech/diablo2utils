/**
 * Diablo II 1.13c — verify game DLLs exist in the given folder.
 */
#ifndef D2_VERSION_H
#define D2_VERSION_H

#include <stdio.h>
#include <windows.h>
#include <fstream>
#include "log.h"

/** Check that Storm.dll exists at the given path (essential for map gen) */
bool game_path_valid(char *folderName) {
    char dllPath[MAX_PATH];
    sprintf(dllPath, "%s\\Storm.dll", folderName);

    std::ifstream ifs(dllPath, std::ifstream::in);
    bool found = !ifs.fail();
    ifs.close();
    log_trace("Init:GamePath", lk_b("exists", found), lk_s("check", dllPath));
    return found;
}

#endif
