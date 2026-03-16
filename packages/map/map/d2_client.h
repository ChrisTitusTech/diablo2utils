#ifndef D2_CLIENT_H
#define D2_CLIENT_H

#include "d2_structs.h"

int get_act(int act);
void d2_game_init(char *folderName);
int d2_dump_map(int seed, int difficulty, int levelCode);

#endif
