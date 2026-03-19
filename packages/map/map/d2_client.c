/**
 * Diablo II 1.13c map generator — vanilla only.
 * Init sequence from jcageman/d2mapapi.
 */
#include <stdio.h>
#include <setjmp.h>
#include <windows.h>

#include <fstream>
#include <iostream>
#include <string>

#include "d2_ptrs.h"
#include "d2_structs.h"
#include "d2_version.h"
#include "d2data/d2_game_object.h"
#include "d2data/d2_npc_type.h"
#include "d2data/d2_level.h"
#include "json.h"
#include "log.h"
#include "map.h"
#include "offset.h"
#include "d2_client_version.h"

#define UNIT_TYPE_PLAYER  0
#define UNIT_TYPE_NPC     1
#define UNIT_TYPE_OBJECT  2
#define UNIT_TYPE_MISSILE 3
#define UNIT_TYPE_ITEM    4
#define UNIT_TYPE_TILE    5

d2client_struct D2Client;
char D2_DIR[MAX_PATH] = "";

/**
 * Fully restore a loaded DLL from its file on disk, then re-resolve imports.
 *
 * Wine + stub DLLs cause DllMain to corrupt ALL sections (including PE
 * section headers in memory).  We read everything from the original file
 * and use the FILE's PE headers (not the in-memory corrupted copies).
 *
 * Steps:
 *  1. Parse PE headers from the DLL FILE (not from memory)
 *  2. Restore all non-.reloc sections from file
 *  3. Apply PE base relocations when DLL was loaded at non-preferred base
 *  4. Re-resolve the Import Address Table (IAT) using GetProcAddress
 */
static void repair_dll_sections(const char *dllName, int restore_data) {
    HMODULE hMod = GetModuleHandle(dllName);
    if (!hMod) {
        log_error("Repair:ModuleNotFound", lk_s("dll", dllName));
        return;
    }

    unsigned char *base = (unsigned char *)hMod;
    DWORD_PTR actualBase = (DWORD_PTR)hMod;

    /* Build file path */
    char filePath[MAX_PATH];
    sprintf_s(filePath, sizeof(filePath), "%s\\%s", D2_DIR, dllName);

    HANDLE hFile = CreateFile(filePath, GENERIC_READ, FILE_SHARE_READ,
                              NULL, OPEN_EXISTING, 0, NULL);
    if (hFile == INVALID_HANDLE_VALUE) {
        log_error("Repair:OpenFailed", lk_s("dll", dllName), lk_s("path", filePath));
        return;
    }

    /* Get file size */
    DWORD fileSize = GetFileSize(hFile, NULL);
    if (fileSize == INVALID_FILE_SIZE || fileSize < 1024) {
        CloseHandle(hFile);
        log_error("Repair:BadFileSize", lk_s("dll", dllName));
        return;
    }

    /* Read entire file for header parsing + section data */
    unsigned char *fileData = (unsigned char *)malloc(fileSize);
    if (!fileData) {
        CloseHandle(hFile);
        log_error("Repair:AllocFailed", lk_s("dll", dllName));
        return;
    }
    SetFilePointer(hFile, 0, NULL, FILE_BEGIN);
    DWORD bytesRead = 0;
    if (!ReadFile(hFile, fileData, fileSize, &bytesRead, NULL) || bytesRead != fileSize) {
        CloseHandle(hFile);
        free(fileData);
        log_error("Repair:ReadFailed", lk_s("dll", dllName));
        return;
    }
    CloseHandle(hFile);

    /* Parse PE headers from FILE data (NOT from corrupted memory) */
    IMAGE_DOS_HEADER *fDos = (IMAGE_DOS_HEADER *)fileData;
    if (fDos->e_magic != IMAGE_DOS_SIGNATURE) {
        free(fileData);
        log_error("Repair:BadDOS", lk_s("dll", dllName));
        return;
    }
    IMAGE_NT_HEADERS *fNt = (IMAGE_NT_HEADERS *)(fileData + fDos->e_lfanew);
    if (fNt->Signature != IMAGE_NT_SIGNATURE) {
        free(fileData);
        log_error("Repair:BadNT", lk_s("dll", dllName));
        return;
    }

    DWORD_PTR preferredBase = (DWORD_PTR)fNt->OptionalHeader.ImageBase;
    LONG delta = (LONG)(actualBase - preferredBase);

    IMAGE_SECTION_HEADER *fSec = IMAGE_FIRST_SECTION(fNt);
    WORD nSections = fNt->FileHeader.NumberOfSections;

    /* Read .reloc from file if DLL is relocated */
    unsigned char *relocData = NULL;
    DWORD relocDataSize = 0;
    if (delta != 0) {
        for (WORD i = 0; i < nSections; i++) {
            if (memcmp(fSec[i].Name, ".reloc", 6) == 0) {
                relocData = fileData + fSec[i].PointerToRawData;
                relocDataSize = fSec[i].SizeOfRawData;
                break;
            }
        }
        if (!relocData) {
            free(fileData);
            log_error("Repair:NoRelocSection", lk_s("dll", dllName));
            return;
        }
    }

    /* Restore .text, .rdata, .rsrc sections (skip .reloc always).
       .data restoration is configurable: D2Lang has Storm function pointers
       in .data that are zero in the file but populated by DllMain at load.
       Other DLLs may have initialized data tables that DllMain corrupts. */
    for (WORD si = 0; si < nSections; si++) {
        if (memcmp(fSec[si].Name, ".reloc", 6) == 0) continue;
        if (!restore_data && memcmp(fSec[si].Name, ".data\0\0\0", 8) == 0) continue;
        if (fSec[si].SizeOfRawData == 0) continue;

        DWORD secRVA      = fSec[si].VirtualAddress;
        DWORD secFileOff   = fSec[si].PointerToRawData;
        DWORD secRawSize   = fSec[si].SizeOfRawData;

        if (secFileOff + secRawSize > fileSize) continue;

        /* Copy file section data to a work buffer */
        unsigned char *secBuf = (unsigned char *)malloc(secRawSize);
        if (!secBuf) continue;
        memcpy(secBuf, fileData + secFileOff, secRawSize);

        /* Apply relocations targeting this section */
        int applied = 0;
        if (delta != 0 && relocData) {
            DWORD secEnd = secRVA + secRawSize;
            unsigned char *rp = relocData;
            unsigned char *rEnd = relocData + relocDataSize;
            while (rp + 8 <= rEnd) {
                DWORD pageRVA   = *(DWORD *)rp;
                DWORD blockSize = *(DWORD *)(rp + 4);
                if (blockSize < 8 || rp + blockSize > rEnd) break;
                int nEntries = (int)(blockSize - 8) / 2;
                WORD *entries = (WORD *)(rp + 8);
                for (int j = 0; j < nEntries; j++) {
                    WORD entry = entries[j];
                    int type   = entry >> 12;
                    int offset = entry & 0xFFF;
                    if (type == IMAGE_REL_BASED_HIGHLOW) {
                        DWORD targetRVA = pageRVA + (DWORD)offset;
                        if (targetRVA >= secRVA && targetRVA + 4 <= secEnd) {
                            DWORD bufOff = targetRVA - secRVA;
                            DWORD val;
                            memcpy(&val, secBuf + bufOff, 4);
                            val = (DWORD)((LONG)val + delta);
                            memcpy(secBuf + bufOff, &val, 4);
                            applied++;
                        }
                    }
                }
                rp += blockSize;
            }
        }

        /* Write repaired section to memory */
        unsigned char *mem = base + secRVA;
        DWORD oldProt;
        if (!VirtualProtect(mem, secRawSize, PAGE_EXECUTE_READWRITE, &oldProt)) {
            free(secBuf);
            continue;
        }
        memcpy(mem, secBuf, secRawSize);

        /* Restore proper protection based on section characteristics.
           Don't restore oldProt — DllMain corruption may have changed it
           to something wrong (e.g. .data losing PAGE_READWRITE). */
        DWORD restoreProt = PAGE_EXECUTE_READ;
        if (fSec[si].Characteristics & IMAGE_SCN_MEM_WRITE)
            restoreProt = PAGE_EXECUTE_READWRITE;
        VirtualProtect(mem, secRawSize, restoreProt, &oldProt);

        FlushInstructionCache(GetCurrentProcess(), mem, secRawSize);
        free(secBuf);

        log_debug("Repair:Section", lk_s("dll", dllName),
            lk_s("sec", (const char *)fSec[si].Name),
            lk_i("rva", (int)secRVA), lk_i("size", (int)secRawSize),
            lk_i("relocs", applied));
    }

    /* Also restore the PE header page (section headers are corrupted too) */
    {
        DWORD hdrSize = fNt->OptionalHeader.SizeOfHeaders;
        if (hdrSize <= fileSize) {
            DWORD oldProt;
            if (VirtualProtect(base, hdrSize, PAGE_READWRITE, &oldProt)) {
                memcpy(base, fileData, hdrSize);
                /* Fix ImageBase if relocated, so in-memory header reflects actual base */
                if (delta != 0) {
                    IMAGE_NT_HEADERS *mNt = (IMAGE_NT_HEADERS *)(base +
                        ((IMAGE_DOS_HEADER *)base)->e_lfanew);
                    mNt->OptionalHeader.ImageBase = (DWORD)actualBase;
                }
                VirtualProtect(base, hdrSize, oldProt, &oldProt);
            }
        }
    }

    /* Re-resolve the IAT using file-based import directory info */
    DWORD impDirRVA = fNt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress;
    if (impDirRVA) {
        IMAGE_IMPORT_DESCRIPTOR *imp = (IMAGE_IMPORT_DESCRIPTOR *)(base + impDirRVA);
        int totalResolved = 0;
        for (; imp->Name != 0; imp++) {
            const char *impDllName = (const char *)(base + imp->Name);
            HMODULE hImpMod = GetModuleHandle(impDllName);
            if (!hImpMod) {
                hImpMod = LoadLibrary(impDllName);
                if (!hImpMod) {
                    log_error("Repair:IAT:LoadFailed", lk_s("dll", dllName),
                        lk_s("import", impDllName));
                    continue;
                }
            }

            IMAGE_THUNK_DATA *ilt = (IMAGE_THUNK_DATA *)(base +
                (imp->OriginalFirstThunk ? imp->OriginalFirstThunk : imp->FirstThunk));
            IMAGE_THUNK_DATA *iat = (IMAGE_THUNK_DATA *)(base + imp->FirstThunk);

            /* Count thunks and make IAT writable */
            int thunkCount = 0;
            for (IMAGE_THUNK_DATA *t = ilt; t->u1.AddressOfData != 0; t++) thunkCount++;
            DWORD iatOldProt;
            VirtualProtect(iat, (thunkCount + 1) * sizeof(IMAGE_THUNK_DATA),
                           PAGE_READWRITE, &iatOldProt);

            int resolved = 0;
            for (; ilt->u1.AddressOfData != 0; ilt++, iat++) {
                FARPROC addr = NULL;
                if (IMAGE_SNAP_BY_ORDINAL(ilt->u1.Ordinal)) {
                    WORD ordinal = (WORD)IMAGE_ORDINAL(ilt->u1.Ordinal);
                    addr = GetProcAddress(hImpMod, (LPCSTR)(DWORD_PTR)ordinal);
                } else {
                    IMAGE_IMPORT_BY_NAME *hint =
                        (IMAGE_IMPORT_BY_NAME *)(base + ilt->u1.AddressOfData);
                    addr = GetProcAddress(hImpMod, (LPCSTR)hint->Name);
                }
                if (addr) {
                    iat->u1.Function = (DWORD_PTR)addr;
                    resolved++;
                }
            }

            VirtualProtect(iat - resolved, (thunkCount + 1) * sizeof(IMAGE_THUNK_DATA),
                           iatOldProt, &iatOldProt);
            totalResolved += resolved;
        }
        log_debug("Repair:IAT", lk_s("dll", dllName), lk_i("resolved", totalResolved));
    }

    free(fileData);
    log_debug("Repair:Done", lk_s("dll", dllName),
        lk_i("relocated", delta != 0 ? 1 : 0));
}

/* Crash recovery: setjmp/longjmp to skip levels that trigger access violations */
static jmp_buf crash_jmp;
static volatile int crash_recovery_active = 0;
int skip_act[5] = {0, 0, 0, 0, 0};
static DWORD main_thread_id = 0;

/* Small trampoline: TerminateThread(GetCurrentThread(), 0).
   Uses TerminateThread instead of ExitThread because ExitThread runs
   DLL_THREAD_DETACH which needs the loader lock — if the crashing thread
   already holds the loader lock (common during DLL init), ExitThread
   deadlocks.  TerminateThread is a hard kill with no cleanup. */
static void __stdcall worker_thread_kill(void) {
    TerminateThread(GetCurrentThread(), 0);
    /* Should never reach here, but just in case: */
    for (;;) SuspendThread(GetCurrentThread());
}

/* Per-thread crash counter for worker threads — avoid infinite crash loops */
static volatile LONG worker_crash_count = 0;
#define WORKER_CRASH_MAX 20

/* Vectored Exception Handler — first-chance handler for crash recovery */
static LONG CALLBACK VectoredCrashHandler(PEXCEPTION_POINTERS pExInfo) {
    DWORD code = pExInfo->ExceptionRecord->ExceptionCode;
    if (code == EXCEPTION_ACCESS_VIOLATION || code == EXCEPTION_STACK_OVERFLOW) {
        CONTEXT *ctx = pExInfo->ContextRecord;
        DWORD eip = ctx->Eip;
        DWORD esp = ctx->Esp;
        DWORD tid = GetCurrentThreadId();

        /* Verbose crash diagnostics only at TRACE level */
        if (log_enabled(LOG_TRACE)) {
            fprintf(stderr, "CRASH: code=0x%08x eip=0x%08x esp=0x%08x ebp=0x%08x eax=0x%08x ecx=0x%08x tid=0x%x\n",
                (unsigned)code, (unsigned)eip, (unsigned)esp, (unsigned)ctx->Ebp,
                (unsigned)ctx->Eax, (unsigned)ctx->Ecx, (unsigned)tid);
            DWORD *stack = (DWORD *)esp;
            fprintf(stderr, "STACK: ");
            for (int i = 0; i < 16 && (DWORD_PTR)(stack + i) < (DWORD_PTR)esp + 0x1000; i++) {
                fprintf(stderr, "%08x ", (unsigned)stack[i]);
            }
            fprintf(stderr, "\n");
            DWORD *frame = (DWORD *)ctx->Ebp;
            fprintf(stderr, "FRAMES: ");
            for (int i = 0; i < 8; i++) {
                if ((DWORD_PTR)frame < 0x10000 || (DWORD_PTR)frame > 0x7FFFFFFF) break;
                fprintf(stderr, "[ebp=%08x ret=%08x] ", (unsigned)(DWORD_PTR)frame, (unsigned)frame[1]);
                frame = (DWORD *)frame[0];
            }
            fprintf(stderr, "\n");
            fflush(stderr);
        }

        if (crash_recovery_active && tid == main_thread_id) {
            crash_recovery_active = 0;
            longjmp(crash_jmp, 1);
        }

        /* Non-main threads: try to keep them alive by faking returns from
           NULL calls, or hard-kill them if too many crashes accumulate. */
        if (tid != main_thread_id) {
            LONG count = InterlockedIncrement(&worker_crash_count);
            if (eip == 0 && count <= WORKER_CRASH_MAX) {
                /* NULL function call: simulate an immediate return (EAX=0). */
                DWORD ret_addr = *(DWORD *)esp;
                log_trace("VEH:WorkerNullCall", lk_i("tid", (int)tid),
                    lk_i("count", (int)count), lk_i("retAddr", (int)ret_addr));
                ctx->Eip = ret_addr;
                ctx->Esp += 4;
                ctx->Eax = 0;
                return EXCEPTION_CONTINUE_EXECUTION;
            }
            /* Too many crashes or non-NULL address: hard-kill the thread */
            log_trace("VEH:WorkerKill", lk_i("tid", (int)tid), lk_i("count", (int)count));
            ctx->Eip = (DWORD)(DWORD_PTR)worker_thread_kill;
            return EXCEPTION_CONTINUE_EXECUTION;
        }
    }
    return EXCEPTION_CONTINUE_SEARCH;
}

DWORD D2ClientInterface(VOID) {
    return D2Client.dwInit;
}

VOID __stdcall ExceptionHandler(VOID) {
    if (crash_recovery_active) {
        crash_recovery_active = 0;
        longjmp(crash_jmp, 1);
    }
    fprintf(stderr, "\n] We got a big Error here! [\n");
    ExitProcess(1);
}

/* InitGameMisc trampoline — jumps into D2Client.dll at 0x4454B.
   Uses __attribute__((naked)) + extended asm, matching jcageman/d2mapapi. */
void __attribute__((naked)) D2CLIENT_InitGameMisc_Trampoline() {
    asm volatile (
        "push %%ecx\n"
        "push %%ebp\n"
        "push %%esi\n"
        "push %%edi\n"
        "jmp *%0\n"
        "ret"
        :
        : "r"(D2CLIENT_InitGameMisc)
    );
}

/**
 * Initialize Diablo II 1.13c DLLs for headless map generation.
 * Sequence matches jcageman/d2mapapi Initialize() exactly.
 */
static void d2_game_init_dlls(void) {
    *p_STORM_MPQHashTable = (DWORD)NULL;
    D2Client.dwInit = 1;
    D2Client.fpInit = (DWORD)D2ClientInterface;

    /* FOG — must be initialized (provides memory management for D2Common) */
    log_debug("Init:Call", lk_s("func", "FOG_10021"));
    FOG_10021("D2");
    log_debug("Init:Call", lk_s("func", "FOG_10101"));
    FOG_10101(1, 0);
    log_debug("Init:Call", lk_s("func", "FOG_10089"));
    FOG_10089(1);
    log_debug("Init:Call", lk_s("func", "FOG_10218"));
    if (!FOG_10218()) {
        log_error("Init:Dll:Failed", lk_s("dll", "Fog.dll"));
        ExitProcess(1);
    }
    log_debug("Init:Dll:Done", lk_s("dll", "Fog.dll"));

    /* D2Win — calls D2Gfx for display init (stub returns 1),
       loads MPQ archives, sets callbacks needed by D2Common */
    log_debug("Init:Call", lk_s("func", "D2WIN_10086"));
    D2WIN_10086();
    log_debug("Init:Call", lk_s("func", "D2WIN_10005"));
    D2WIN_10005(0, 0, 0, &D2Client);
    log_debug("Init:Dll:Done", lk_s("dll", "D2Win.dll"));

    /* D2Lang — needed by D2Common_InitDataTables internally */
    log_debug("Init:Call", lk_s("func", "D2LANG_10008"));
    D2LANG_10008(0, "ENG", 0);
    log_debug("Init:Dll:Done", lk_s("dll", "D2Lang.dll"));

    /* D2Common — InitDataTables.
       FLS function pointers and slot have already been set up in
       d2_game_init() (before D2Win created worker threads), so the
       CRT's own init path runs safely here. */
    log_info("Init:Call", lk_s("func", "D2COMMON_InitDataTables"),
             lk_i("addr", (int)(DWORD_PTR)D2COMMON_InitDataTables));
    D2COMMON_InitDataTables(0, 0, 0);
    log_info("Init:Dll:Done", lk_s("dll", "D2Common.dll"));

    /* D2Client — InitGameMisc: sets up D2Client internal state needed
       for map generation (act loading, game state, etc.).
       The trampoline pushes registers and jumps to mid-function at
       D2Client+0x4454B, matching jcageman/d2mapapi. */
    log_debug("Init:Call", lk_s("func", "D2CLIENT_InitGameMisc"));
    D2CLIENT_InitGameMisc_Trampoline();
    log_debug("Init:Dll:Done", lk_s("dll", "D2Client.dll"));
}

void d2_game_init(char *folderName) {
    log_debug("Init:Dll", lk_s("path", folderName));

    if (!game_path_valid(folderName)) {
        log_error("Init:Failed:GameNotFound", lk_s("path", folderName));
        ExitProcess(1);
    }

    /* Set registry InstallPath so DLLs can find game data */
    LPCTSTR keyName = TEXT("SOFTWARE\\Blizzard Entertainment\\Diablo II");
    HKEY hKey;
    LONG openRes = RegOpenKeyEx(HKEY_CURRENT_USER, keyName, 0, KEY_ALL_ACCESS, &hKey);
    if (openRes == ERROR_SUCCESS) {
        LPCTSTR value = TEXT("InstallPath");
        RegSetValueEx(hKey, value, 0, REG_SZ, (LPBYTE)folderName, strlen(folderName) + 1);
        log_info("Registry:InstallPath", lk_s("value", folderName));
        RegCloseKey(hKey);
    } else {
        log_error("Registry:Failed:Open");
        ExitProcess(1);
    }

    sprintf_s(D2_DIR, sizeof(D2_DIR), "%s", folderName);
    log_info("Init:Game", lk_s("path", D2_DIR));
    memset(&D2Client, (DWORD)NULL, sizeof(d2client_struct));
    SetCurrentDirectory(D2_DIR);

    DefineOffsets();
    log_debug("Init:Offsets:Defined");

    /* Log all resolved function pointer addresses for debugging */
    log_debug("Init:Ptrs:FOG",
        lk_i("10021", (int)(DWORD_PTR)FOG_10021),
        lk_i("10101", (int)(DWORD_PTR)FOG_10101),
        lk_i("10089", (int)(DWORD_PTR)FOG_10089),
        lk_i("10218", (int)(DWORD_PTR)FOG_10218));
    log_debug("Init:Ptrs:D2WIN",
        lk_i("10086", (int)(DWORD_PTR)D2WIN_10086),
        lk_i("10005", (int)(DWORD_PTR)D2WIN_10005));
    log_debug("Init:Ptrs:D2LANG",
        lk_i("10008", (int)(DWORD_PTR)D2LANG_10008));
    log_debug("Init:Ptrs:STORM",
        lk_i("Hash", (int)(DWORD_PTR)p_STORM_MPQHashTable),
        lk_i("SFileOpen", (int)(DWORD_PTR)STORM_SFileOpenArchive));
    log_debug("Init:Ptrs:D2CLIENT",
        lk_i("InitGM", (int)(DWORD_PTR)D2CLIENT_InitGameMisc),
        lk_i("LA1", (int)D2CLIENT_LoadAct_1),
        lk_i("LA2", (int)D2CLIENT_LoadAct_2));
    log_debug("Init:Ptrs:D2COMMON",
        lk_i("InitDT", (int)(DWORD_PTR)D2COMMON_InitDataTables),
        lk_i("LoadAct", (int)(DWORD_PTR)D2COMMON_LoadAct),
        lk_i("UnloadAct", (int)(DWORD_PTR)D2COMMON_UnloadAct),
        lk_i("GetLevel", (int)(DWORD_PTR)D2COMMON_GetLevel));

    /* Verify modules are at expected bases */
    log_debug("Init:Modules",
        lk_i("Fog", (int)(DWORD_PTR)GetModuleHandle("Fog.dll")),
        lk_i("D2Win", (int)(DWORD_PTR)GetModuleHandle("D2Win.dll")),
        lk_i("D2Lang", (int)(DWORD_PTR)GetModuleHandle("D2Lang.dll")),
        lk_i("Storm", (int)(DWORD_PTR)GetModuleHandle("Storm.dll")),
        lk_i("D2Client", (int)(DWORD_PTR)GetModuleHandle("D2Client.dll")),
        lk_i("D2Common", (int)(DWORD_PTR)GetModuleHandle("D2Common.dll")));

    /* Repair corrupted .text and .rdata sections from DllMain corruption.
       Must repair ALL D2 DLLs in the call chain, not just directly-used ones.
       .data restoration: only for DLLs with corrupted initialized data that
       don't have critical sections/runtime state set by DllMain.
       - D2Common: skip .data (DllMain sets runtime callbacks at .data+0x6760)
       - D2Lang: skip .data (has Storm function pointers set by DllMain)
       - Storm/Fog: skip .data (have critical sections initialized by DllMain)
       - D2Win: skip .data (has DllMain-initialized state)
       - Others: restore .data (safer default) */
    repair_dll_sections("D2Client.dll", 1);
    repair_dll_sections("D2Common.dll", 0);

    /* ── Early D2Common CRT FLS/TLS init ──────────────────────────────
       D2Common's MSVC CRT uses Fiber Local Storage (FlsSetValue etc.)
       for thread-local data.  The CRT init function (RVA 0x365C) that
       sets these up doesn't run until InitDataTables—but worker threads
       spawned by D2Win/D2CMP call through NULL FLS pointers and crash.
       Fix: write the FLS function pointers + allocate a slot NOW,
       before any other DLL init creates threads. */
    {
        HMODULE hD2C = GetModuleHandle("D2Common.dll");
        DWORD d2c = (DWORD)(DWORD_PTR)hD2C;

        /* FLS function pointer slots in D2Common .data:
           +0x9F75C = FlsAlloc,    +0x9F760 = FlsGetValue,
           +0x9F764 = FlsSetValue,  +0x9F768 = FlsFree
           Slot index variable at +0x992FC
           FlsAlloc callback at code RVA 0x34E6 */
        DWORD *pFnSlots  = (DWORD *)(d2c + 0x9F75C);
        DWORD *pSlotIdx  = (DWORD *)(d2c + 0x992FC);
        DWORD cb_addr    = d2c + 0x34E6;

        HMODULE hK32 = GetModuleHandle("kernel32.dll");
        FARPROC fFlsAlloc    = GetProcAddress(hK32, "FlsAlloc");
        FARPROC fFlsSetValue = GetProcAddress(hK32, "FlsSetValue");
        FARPROC fFlsGetValue = GetProcAddress(hK32, "FlsGetValue");
        FARPROC fFlsFree     = GetProcAddress(hK32, "FlsFree");

        DWORD oldProt;
        if (fFlsAlloc && fFlsSetValue && fFlsGetValue && fFlsFree) {
            /* Write FLS function pointers */
            VirtualProtect(pFnSlots, 16, PAGE_READWRITE, &oldProt);
            pFnSlots[0] = (DWORD)(DWORD_PTR)fFlsAlloc;
            pFnSlots[1] = (DWORD)(DWORD_PTR)fFlsGetValue;
            pFnSlots[2] = (DWORD)(DWORD_PTR)fFlsSetValue;
            pFnSlots[3] = (DWORD)(DWORD_PTR)fFlsFree;
            VirtualProtect(pFnSlots, 16, oldProt, &oldProt);

            /* Allocate FLS slot with D2Common's own callback */
            typedef DWORD (WINAPI *PFN_FlsAlloc)(PVOID);
            DWORD slot = ((PFN_FlsAlloc)fFlsAlloc)((PVOID)(DWORD_PTR)cb_addr);
            VirtualProtect(pSlotIdx, 4, PAGE_READWRITE, &oldProt);
            *pSlotIdx = slot;
            VirtualProtect(pSlotIdx, 4, oldProt, &oldProt);

            log_info("Init:D2Common:FLS",
                lk_i("slot", (int)slot),
                lk_i("FlsSetValue", (int)(DWORD_PTR)fFlsSetValue));
        } else {
            /* FLS not available — use TLS fallback */
            FARPROC fTlsAlloc    = GetProcAddress(hK32, "TlsAlloc");
            FARPROC fTlsSetValue = GetProcAddress(hK32, "TlsSetValue");
            FARPROC fTlsGetValue = GetProcAddress(hK32, "TlsGetValue");
            FARPROC fTlsFree     = GetProcAddress(hK32, "TlsFree");

            VirtualProtect(pFnSlots, 16, PAGE_READWRITE, &oldProt);
            pFnSlots[0] = (DWORD)(DWORD_PTR)fTlsAlloc;
            pFnSlots[1] = (DWORD)(DWORD_PTR)fTlsGetValue;
            pFnSlots[2] = (DWORD)(DWORD_PTR)fTlsSetValue;
            pFnSlots[3] = (DWORD)(DWORD_PTR)fTlsFree;
            VirtualProtect(pFnSlots, 16, oldProt, &oldProt);

            typedef DWORD (WINAPI *PFN_TlsAlloc)(void);
            DWORD slot = ((PFN_TlsAlloc)fTlsAlloc)();
            VirtualProtect(pSlotIdx, 4, PAGE_READWRITE, &oldProt);
            *pSlotIdx = slot;
            VirtualProtect(pSlotIdx, 4, oldProt, &oldProt);

            log_info("Init:D2Common:TLS",
                lk_i("slot", (int)slot));
        }

        /* Stub out D2Common's CRT __crtFlsInit at RVA 0x365C.
           DllMain already set the init flag, so when InitDataTables
           calls into the CRT, __crtFlsInit re-runs FLS setup:
             call 0x2DA6  → flag nonzero (DllMain set it)
             jne  → FLS setup: FlsAlloc(new slot) overwrites 0x6fde92fc
             calloc(1,0x8c) → _getptd_noexit → FlsGetValue(new_slot)=NULL
             → calloc → _getptd_noexit → ... infinite recursion
           Fix: replace the function body with "mov eax,1; ret" so it
           returns success immediately. All FLS/heap/ptd work is done. */
        {
            BYTE *fn = (BYTE *)(d2c + 0x365C);
            VirtualProtect(fn, 6, PAGE_EXECUTE_READWRITE, &oldProt);
            fn[0] = 0xB8; fn[1] = 0x01; fn[2] = 0x00;
            fn[3] = 0x00; fn[4] = 0x00; fn[5] = 0xC3;  /* mov eax,1; ret */
            VirtualProtect(fn, 6, oldProt, &oldProt);
            log_debug("Init:D2Common:CRT:FlsInitStubbed");
        }

        /* Call D2Common's CRT _heap_init (RVA 0x59FC) to create the
           CRT private heap.  Without DllMain, _crtheap at .data+0xA170C
           (abs 0x6fdf170c) stays NULL and any CRT calloc/malloc crashes.
           _heap_init(0) calls HeapCreate and stores the handle.
           Must be called after IAT repair (HeapCreate import resolved). */
        {
            typedef int (__cdecl *PFN_heap_init)(int);
            PFN_heap_init heap_init = (PFN_heap_init)(d2c + 0x59FC);
            int ret = heap_init(0);
            log_debug("Init:D2Common:CRT:HeapInit", lk_i("ret", ret));

            /* Disable the Small Block Heap (SBH).  D2Common's CRT
               malloc/calloc check the flag at .data+0xA1710: if == 3,
               the SBH path calls _lock(4) which triggers _mtinitlocknum
               → _lock(10) → _mtinitlocknum(10) → _lock(10) → infinite
               recursion because _mtinit never ran.  Setting the flag to
               0 makes all allocations go through HeapAlloc directly,
               which has its own internal locking. */
            DWORD *pSbhFlag = (DWORD *)(d2c + 0xA1710);
            DWORD sbhOld;
            VirtualProtect(pSbhFlag, 4, PAGE_READWRITE, &sbhOld);
            *pSbhFlag = 0;
            VirtualProtect(pSbhFlag, 4, sbhOld, &sbhOld);
            log_debug("Init:D2Common:CRT:SBH:Disabled");

            /* Pre-initialize CRT bootstrap lock (lock_table[10]).
               _mtinitlocknum(n) acquires lock 10 to safely create lock n.
               Without _mtinit, lock 10 is NULL → _mtinitlocknum(10) is
               called which recurses infinitely.  Manually create a
               CRITICAL_SECTION and store it in the lock table. */
            {
                HANDLE crtheap_init = *(HANDLE *)(d2c + 0xA170C);
                DWORD *lock10 = (DWORD *)(d2c + 0x99048 + 10 * 8);
                CRITICAL_SECTION *cs = (CRITICAL_SECTION *)HeapAlloc(
                    crtheap_init, HEAP_ZERO_MEMORY, sizeof(CRITICAL_SECTION));
                if (cs) {
                    InitializeCriticalSectionAndSpinCount(cs, 0xFA0);
                    DWORD lockOld;
                    VirtualProtect(lock10, 4, PAGE_READWRITE, &lockOld);
                    *lock10 = (DWORD)(DWORD_PTR)cs;
                    VirtualProtect(lock10, 4, lockOld, &lockOld);
                    log_debug("Init:D2Common:CRT:Lock10",
                        lk_i("cs", (int)(DWORD_PTR)cs));
                }
            }
        }

        /* Pre-allocate per-thread CRT data for the main thread.
           D2Common's _getptd_noexit (RVA 0x3475) lazily allocates a
           0x8c-byte block via calloc, but calloc itself may recurse
           into _getptd_noexit → infinite recursion → stack overflow.
           Fix: HeapAlloc the block directly from _crtheap, initialize
           the critical fields, and store it via FlsSetValue so that
           the first real _getptd_noexit call finds it already set. */
        {
            HANDLE crtheap = *(HANDLE *)(d2c + 0xA170C);  /* _crtheap */
            DWORD slot     = *pSlotIdx;
            void *ptd = HeapAlloc(crtheap, HEAP_ZERO_MEMORY, 0x8C);
            if (ptd) {
                /* Match _getptd_noexit init at RVA 0x34B6..0x34D0:
                   +0x00 = GetCurrentThreadId()
                   +0x04 = 0xFFFFFFFF
                   +0x14 = 1
                   +0x54 = address of CRT per-thread exception table */
                DWORD *p = (DWORD *)ptd;
                p[0]          = GetCurrentThreadId();
                p[1]          = 0xFFFFFFFF;            /* +0x04 */
                p[5]          = 1;                      /* +0x14 */
                *(DWORD *)((BYTE *)ptd + 0x54) = d2c + 0x99720; /* table ptr */

                typedef BOOL (WINAPI *PFN_FlsSetValue)(DWORD, PVOID);
                ((PFN_FlsSetValue)(DWORD_PTR)pFnSlots[2])(slot, ptd);
                log_debug("Init:D2Common:CRT:PerThread",
                    lk_i("ptd", (int)(DWORD_PTR)ptd),
                    lk_i("slot", (int)slot));
            }
        }
    }

    repair_dll_sections("D2Win.dll", 0);
    repair_dll_sections("D2Lang.dll", 0);
    repair_dll_sections("Storm.dll", 0);
    repair_dll_sections("Fog.dll", 0);
    repair_dll_sections("D2CMP.dll", 1);
    repair_dll_sections("D2Game.dll", 1);
    repair_dll_sections("D2Net.dll", 1);

    /* Register vectored exception handler for crash recovery.
       Record main thread ID so the handler can redirect worker-thread
       crashes to ExitThread instead of killing the whole process. */
    main_thread_id = GetCurrentThreadId();
    AddVectoredExceptionHandler(1, VectoredCrashHandler);

    d2_game_init_dlls();

    SetCurrentDirectory(folderName);
}

/* ------------------------------------------------------------------ */
/*  Map generation helpers                                             */
/* ------------------------------------------------------------------ */

Level *__fastcall d2_get_level(ActMisc *misc, DWORD levelCode) {
    log_trace("Map:GetLevel:Start", lk_i("misc", (int)misc), lk_i("levelCode", levelCode));
    LevelTxt *levelData = d2common_get_level_text(levelCode);
    if (!levelData) return NULL;

    for (Level *pLevel = misc->pLevelFirst; pLevel; pLevel = pLevel->pNextLevel) {
        if (pLevel->dwLevelNo == levelCode) return pLevel;
    }

    return d2common_get_level(misc, levelCode);
}

void add_collision_data(CollMap *pCol, int originX, int originY) {
    if (pCol == NULL) return;

    int x = pCol->dwPosGameX - originX;
    int y = pCol->dwPosGameY - originY;
    int cx = pCol->dwSizeGameX;
    int cy = pCol->dwSizeGameY;

    int nLimitX = x + cx;
    int nLimitY = y + cy;

    WORD *p = pCol->pMapStart;
    for (int j = y; j < nLimitY; j++) {
        for (int i = x; i < nLimitX; i++) {
            int pVal = *p;
            if (pVal == 1024) pVal = 1;
            map_set(i, j, pVal);
            p++;
        }
    }
}

char *get_object_type(int code) {
    if (object_is_useless(code)) return NULL;
    return "object";
}

char *get_object_class(int code, char *name, int operateFn) {
    switch (operateFn) {
        case 1: return "casket";
        case 2: return "shrine";
        case 3: return "urn";
        case 5: return "barrel";
        case 7: return "barrel-exploding";
        case 14: return "bolder";
        case 19: return "rack-armor";
        case 20: return "rack-weapon";
        case 22: return "well";
        case 23: return "waypoint";
        case 68: return "urn-evil";
        case 30: return "chest-exploding";
        case 40:
        case 41:
        case 59:
        case 58:
        case 4:
            return "chest";
        case 8:
        case 18:
        case 29:
            return "door";
        case 54:
        case 52:
        case 55:
        case 56:
        case 9:
        case 53:
        case 25:
        case 45:
        case 49:
        case 28:
        case 24:
            return "quest";
    }

    if (code == 580 || code == 581) return "chest-super";
    return NULL;
}

bool is_good_exit(Act *pAct, Level *pLevel, int exitId) {
    /* Act 1 */
    if (pLevel->dwLevelNo == AreaLevel::BloodMoor && exitId == AreaLevel::DenOfEvil) return true;
    if (pLevel->dwLevelNo == AreaLevel::TamoeHighland && exitId == AreaLevel::PitLevel1) return true;
    if (pLevel->dwLevelNo == AreaLevel::BlackMarsh && exitId == AreaLevel::ForgottenTower) return true;

    /* Act 2 */
    if (exitId == pAct->pMisc->dwStaffTombLevel) return true;
    if (pLevel->dwLevelNo == AreaLevel::FarOasis && exitId == AreaLevel::MaggotLairLevel1) return true;
    if (pLevel->dwLevelNo == AreaLevel::ValleyOfSnakes && exitId == AreaLevel::ClawViperTempleLevel1) return true;
    if (pLevel->dwLevelNo == AreaLevel::RockyWaste && exitId == AreaLevel::StonyTombLevel1) return true;
    if (pLevel->dwLevelNo == AreaLevel::LostCity && exitId == AreaLevel::AncientTunnels) return true;

    /* Act 3 */
    if (pLevel->dwLevelNo == AreaLevel::SpiderForest && exitId == AreaLevel::SpiderCavern) return true;
    if (pLevel->dwLevelNo == AreaLevel::FlayerJungle && exitId == AreaLevel::FlayerDungeonLevel1) return true;
    if (pLevel->dwLevelNo == AreaLevel::KurastBazaar && exitId == AreaLevel::RuinedTemple) return true;

    /* Act 5 */
    if (pLevel->dwLevelNo == AreaLevel::CrystallinePassage && exitId == AreaLevel::FrozenRiver) return true;

    return false;
}

int dump_objects(Act *pAct, Level *pLevel, Room2 *pRoom2) {
    int offsetX = pLevel->dwPosX * 5;
    int offsetY = pLevel->dwPosY * 5;

    int roomOffsetX = pRoom2->dwPosX * 5 - offsetX;
    int roomOffsetY = pRoom2->dwPosY * 5 - offsetY;

    for (PresetUnit *pPresetUnit = pRoom2->pPreset; pPresetUnit; pPresetUnit = pPresetUnit->pPresetNext) {
        char *objectType = NULL;
        char *objectName = NULL;
        char *objectClass = NULL;
        bool isGoodExit = false;
        int operateFn = -1;
        int objectId = -1;

        int coordX = roomOffsetX + pPresetUnit->dwPosX;
        int coordY = roomOffsetY + pPresetUnit->dwPosY;

        if (pPresetUnit->dwType == UNIT_TYPE_NPC) {
            if (npc_is_useless(pPresetUnit->dwTxtFileNo)) continue;
            objectType = "npc";
            objectId = pPresetUnit->dwTxtFileNo;
        } else if (pPresetUnit->dwType == UNIT_TYPE_OBJECT) {
            objectType = get_object_type(pPresetUnit->dwTxtFileNo);
            if (!objectType) continue;
            objectId = pPresetUnit->dwTxtFileNo;
            if (pPresetUnit->dwTxtFileNo < 580) {
                ObjectTxt *txt = d2common_get_object_txt(pPresetUnit->dwTxtFileNo);
                objectName = txt->szName;
                if (txt->nSelectable0) operateFn = txt->nOperateFn;
            }
            objectClass = get_object_class(pPresetUnit->dwTxtFileNo, objectName, operateFn);
        } else if (pPresetUnit->dwType == UNIT_TYPE_TILE) {
            for (RoomTile *pRoomTile = pRoom2->pRoomTiles; pRoomTile; pRoomTile = pRoomTile->pNext) {
                if (*pRoomTile->nNum == pPresetUnit->dwTxtFileNo) {
                    objectId = pRoomTile->pRoom2->pLevel->dwLevelNo;
                    if (is_good_exit(pAct, pLevel, objectId)) isGoodExit = true;
                    objectType = "exit";
                }
            }
        }

        if (objectType) {
            json_object_start();
            json_key_value("id", objectId);
            json_key_value("type", objectType);
            json_key_value("x", coordX);
            json_key_value("y", coordY);
            if (objectName) json_key_value("name", objectName);
            if (operateFn > -1) json_key_value("op", operateFn);
            if (isGoodExit) json_key_value("isGoodExit", true);
            if (objectClass) json_key_value("class", objectClass);
            json_object_end();
        }
    }
    return 0;
}

void dump_map_collision(int width, int height) {
    int maxY = map_max_y();
    for (int y = 0; y <= maxY; y++) {
        json_array_start();
        char last = 'X';
        int count = 0;
        int outputCount = 0;
        for (int x = 0; x < width; x++) {
            char mapVal = map_value(x, y) % 2 ? 'X' : ' ';
            if (mapVal == last) {
                count++;
                continue;
            }

            if (outputCount == 0 && last == ' ') fprintf(stderr, "-1, ");
            json_value(count);
            outputCount++;
            count = 1;
            last = mapVal;
        }
        json_array_end();
    }
}

/** Get the correct Act for a level */
int get_act(int levelCode) {
    if (levelCode < 40) return 0;
    if (levelCode < 75) return 1;
    if (levelCode < 103) return 2;
    if (levelCode < 109) return 3;
    if (levelCode < 200) return 4;
    return -1;
}

int d2_dump_map(unsigned int seed, int difficulty, int levelCode) {
    log_trace("Map:DumpStart", lk_i("levelCode", levelCode));
    LevelTxt *levelData = d2common_get_level_text(levelCode);
    if (!levelData) {
        log_trace("Map:DumpFail", lk_i("levelCode", levelCode), lk_s("reason", "no_level_text"));
        return 1;
    }

    int actId = get_act(levelCode);
    if (actId >= 0 && actId < 5 && skip_act[actId]) {
        log_trace("Map:DumpFail", lk_i("levelCode", levelCode), lk_s("reason", "act_skipped"));
        return 1;
    }

    /* Crash recovery: if D2Common crashes, longjmp back here */
    fflush(stdout);
    fflush(stderr);
    crash_recovery_active = 1;
    if (setjmp(crash_jmp) != 0) {
        crash_recovery_active = 0;
        log_warn("Map:DumpFail", lk_i("levelCode", levelCode), lk_i("actId", actId), lk_s("reason", "crash_recovered"));
        fflush(stdout);
        fflush(stderr);
        if (actId >= 0 && actId < 5) {
            skip_act[actId] = 1;
            acts[actId] = NULL;
            act_seeds[actId] = 0;
            act_diff[actId] = -1;
        }
        return 1;
    }

    log_trace("Map:LoadAct", lk_i("levelCode", levelCode), lk_i("actId", actId));
    Act *pAct = d2common_load_act(actId, seed, difficulty);
    if (!pAct) {
        crash_recovery_active = 0;
        log_warn("Map:DumpFail", lk_i("levelCode", levelCode), lk_s("reason", "load_act_null"));
        return 1;
    }

    ActMisc *pMisc = pAct->pMisc;
    if (!pMisc) {
        crash_recovery_active = 0;
        log_warn("Map:DumpFail", lk_i("levelCode", levelCode), lk_s("reason", "pMisc_null"));
        return 1;
    }

    Level *pLevel = d2_get_level(pMisc, levelCode);
    if (!pLevel) {
        crash_recovery_active = 0;
        log_trace("Map:DumpFail", lk_i("levelCode", levelCode), lk_s("reason", "get_level_null"));
        return 1;
    }

    char *levelName = levelData->szName;
    if (!pLevel->pRoom2First) {
        d2common_init_level(pLevel);
    }

    crash_recovery_active = 0;

    if (!pLevel->pRoom2First) {
        log_warn("Map:SkippingLevel:FailedRoomLoading", lk_i("mapId", levelCode), lk_s("mapName", levelName));
        return 1;
    }

    int originX = pLevel->dwPosX * 5;
    int originY = pLevel->dwPosY * 5;
    int mapWidth = pLevel->dwSizeX * 5;
    int mapHeight = pLevel->dwSizeY * 5;

    log_trace("MapInit", lk_i("actId", actId), lk_i("mapId", levelCode), lk_s("mapName", levelName),
              lk_i("originY", originY), lk_i("originX", originX), lk_i("width", mapWidth), lk_i("height", mapHeight));
    map_reset();

    /* JSON output */
    json_start();
    json_key_value("type", "map");
    json_key_value("id", levelCode);
    json_key_value("name", levelName);

    json_object_start("offset");
    json_key_value("x", originX);
    json_key_value("y", originY);
    json_object_end();

    json_object_start("size");
    json_key_value("width", mapWidth);
    json_key_value("height", mapHeight);
    json_object_end();

    json_array_start("objects");
    for (Room2 *pRoom2 = pLevel->pRoom2First; pRoom2; pRoom2 = pRoom2->pRoom2Next) {
        BOOL bAdded = !pRoom2->pRoom1;
        if (bAdded) d2common_add_room_data(pAct, pLevel, pRoom2);
        dump_objects(pAct, pLevel, pRoom2);
        if (pRoom2->pRoom1) add_collision_data(pRoom2->pRoom1->Coll, originX, originY);
        if (bAdded) d2common_remove_room_data(pAct, pLevel, pRoom2);
    }
    json_array_end();

    json_array_start("map");
    dump_map_collision(mapWidth, mapHeight);
    json_array_end();

    json_end();
    return 0;
}
