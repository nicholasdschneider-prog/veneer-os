/* Harmless arm64 fixture only. Never reads a real secret or business target. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <arpa/inet.h>

static int read_attempt(const char *path) {
  int fd = open(path, O_RDONLY);
  int result = fd < 0 ? errno : 0;
  if (fd >= 0) close(fd);
  return result;
}
static int write_attempt(const char *path) {
  int fd = open(path, O_WRONLY | O_CREAT, 0600);
  int result = fd < 0 ? errno : 0;
  if (fd >= 0) { write(fd, "synthetic", 9); close(fd); }
  return result;
}
static int tcp_attempt(int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return errno;
  struct sockaddr_in addr = {0};
  addr.sin_family = AF_INET;
  addr.sin_port = htons((unsigned short)port);
  inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
  int result = connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0 ? errno : 0;
  close(fd);
  return result;
}
static int unix_attempt(const char *path) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return errno;
  struct sockaddr_un addr = {0};
  addr.sun_family = AF_UNIX;
  if (strlen(path) >= sizeof(addr.sun_path)) { close(fd); return EINVAL; }
  strcpy(addr.sun_path, path);
  int result = connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0 ? errno : 0;
  close(fd);
  return result;
}
static int spawn_attempt(const char *binary) {
  pid_t pid;
  char *args[] = {(char *)binary, "--spawn-child", NULL};
  char *env[] = {"LANG=C", NULL};
  int result = posix_spawn(&pid, binary, NULL, NULL, args, env);
  if (result == 0) waitpid(pid, NULL, 0);
  return result;
}
int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--spawn-child") == 0) return 0;
  if (argc != 8) return 64;
  int allowed_read = read_attempt(argv[1]);
  int denied_read = read_attempt(argv[2]);
  int denied_write = write_attempt(argv[3]);
  int denied_tcp = tcp_attempt(atoi(argv[4]));
  int denied_unix = unix_attempt(argv[5]);
  int allowed_write = write_attempt(argv[6]);
  int symlink_read = read_attempt(argv[7]);
  int own_spawn = spawn_attempt(argv[0]);
  int other_spawn = spawn_attempt("/usr/bin/true");
  int fd3_closed = fcntl(3, F_GETFD) < 0 && errno == EBADF;
  int inherited_marker_absent = getenv("FIXTURE_PARENT_CANARY") == NULL;
  int fork_error = 0;
  pid_t child = fork();
  if (child < 0) fork_error = errno;
  else if (child == 0) {
    /* Supplemental fork-enabled diagnostic checks inherited restrictions. */
    int denied = read_attempt(argv[2]) == EPERM && tcp_attempt(atoi(argv[4])) == EPERM;
    _exit(denied ? 0 : 7);
  } else {
    int status = 0; waitpid(child, &status, 0);
    fork_error = WIFEXITED(status) && WEXITSTATUS(status) == 0 ? -1 : -2;
  }
  printf("{\"booted\":true,\"allowedReadErrno\":%d,\"deniedReadErrno\":%d,\"deniedWriteErrno\":%d,\"deniedTcpErrno\":%d,\"deniedUnixErrno\":%d,\"ownSpawnErrno\":%d,\"otherSpawnErrno\":%d,\"forkResult\":%d,\"allowedWriteErrno\":%d,\"symlinkReadErrno\":%d,\"fd3Closed\":%s,\"parentMarkerAbsent\":%s}\n",
    allowed_read, denied_read, denied_write, denied_tcp, denied_unix, own_spawn, other_spawn, fork_error, allowed_write, symlink_read,
    fd3_closed ? "true" : "false", inherited_marker_absent ? "true" : "false");
  return 0;
}
