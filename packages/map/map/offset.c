
#define _DEFINE_VARS
#include <stdio.h>

#include "log.h"
#include "d2_ptrs.h"

const char *dlls[] = {
    "D2Client.DLL",
    "D2Common.DLL",
    "D2Gfx.DLL",
    "D2Lang.DLL",
    "D2Win.DLL",
    "D2Net.DLL",
    "D2Game.DLL",
    "D2Launch.DLL",
    "Fog.DLL",
    "BNClient.DLL",
    "Storm.DLL",
    "D2Cmp.DLL"
};

DWORD GetDllOffset(const char *DllName, int Offset) {
    HMODULE hMod = GetModuleHandle(DllName);
    if (!hMod) hMod = LoadLibrary(DllName);
    if (!hMod) return 0;
    if (Offset < 0) return (DWORD)GetProcAddress(hMod, (LPCSTR)(-Offset));
    return ((DWORD)hMod) + Offset;
}

DWORD GetDllOffset(int num) {
    if ((num & 0xff) > 12) return 0;
    
    DWORD offset = GetDllOffset(dlls[num & 0xff], num >> 8);
    if (offset == 0) {
        log_error("Dll:Init:Failed", lk_s("dll",dlls[num & 0xff]), lk_i("offset", offset));
        exit(1);
    }
    log_trace("Dll:Init", lk_s("dll",dlls[num & 0xff]), lk_i("offset", offset));
    return offset;
}

void DefineOffsets() {
    DWORD *p = (DWORD *)&_D2PTRS_START;
    do {
        *p = GetDllOffset(*p);
    } while (++p <= (DWORD *)&_D2PTRS_END);
}
