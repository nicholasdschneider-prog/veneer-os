/* Synthetic process environment probe. Never prints environment bytes. */
#include <sys/sysctl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc == 1) { char byte; (void)read(0, &byte, 1); return 0; }
  if (argc != 2) return 64;
  int mib[] = {CTL_KERN, KERN_PROCARGS2, atoi(argv[1])};
  char buffer[65536] = {0}; size_t size = sizeof(buffer);
  int result = sysctl(mib, 3, buffer, &size, NULL, 0);
  int error = result < 0 ? errno : 0, marker = 0;
  const char *canary = "FIXTURE_PARENT_CANARY=synthetic";
  if (!error) for (size_t i = 0; i + strlen(canary) < size; i++)
    if (!memcmp(buffer + i, canary, strlen(canary))) marker = 1;
  printf("{\"errno\":%d,\"syntheticMarkerObserved\":%s}\n", error, marker ? "true" : "false");
  memset(buffer, 0, sizeof(buffer));
  return 0;
}
