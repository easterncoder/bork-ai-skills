#define _GNU_SOURCE
#include <pty.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

/* Keep a private attached terminal rendered until its owned child exits. */
int main(int argc, char **argv)
{
    if (argc < 5) return 2;
    int master;
    struct winsize size = {.ws_row = atoi(argv[2]), .ws_col = atoi(argv[3])};
    pid_t child = forkpty(&master, NULL, NULL, &size);
    if (child < 0) return 3;
    if (child == 0) {
        FILE *record = fopen(argv[1], "w");
        if (!record) _exit(4);
        fprintf(record, "%s", ttyname(STDIN_FILENO));
        fclose(record);
        execvp(argv[4], &argv[4]);
        _exit(127);
    }
    char buffer[65536];
    int status = 0;
    while (waitpid(child, &status, WNOHANG) == 0) {
        struct pollfd event = {.fd = master, .events = POLLIN};
        if (poll(&event, 1, 100) > 0 && (event.revents & POLLIN)) {
            ssize_t count = read(master, buffer, sizeof(buffer));
            if (count > 0) { /* Drain output exactly as an attached renderer does. */ }
        }
    }
    close(master);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
